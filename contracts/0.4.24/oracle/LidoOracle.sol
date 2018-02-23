// SPDX-FileCopyrightText: 2020 Lido <info@lido.fi>

// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.4.24;

import "@aragon/os/contracts/apps/AragonApp.sol";
import "@aragon/os/contracts/lib/math/SafeMath.sol";
import "@aragon/os/contracts/lib/math/SafeMath64.sol";

import "../interfaces/ILidoOracle.sol";
import "../interfaces/ILido.sol";
import "../interfaces/ISTETH.sol";

import "./BitOps.sol";


/**
  * @title Implementation of an ETH 2.0 -> ETH oracle
  *
  * The goal of the oracle is to inform other parts of the system about balances controlled
  * by the DAO on the ETH 2.0 side. The balances can go up because of reward accumulation
  * and can go down because of slashing.
  *
  * The timeline is divided into consecutive reportIntervals. At most one data point is produced per reportInterval.
  * A data point is considered finalized (produced) as soon as `quorum` oracle committee members
  * send data.
  * There can be gaps in data points if for some point `quorum` is not reached.
  * It's prohibited to add data to non-current data points whatever finalized or not.
  * It's prohibited to add data to the current finalized data point.
  */
contract LidoOracle is ILidoOracle, AragonApp {
    using SafeMath for uint256;
    using SafeMath64 for uint64;
    using BitOps for uint256;

    struct BeaconSpec {
        uint64 epochsPerFrame;
        uint64 slotsPerEpoch;
        uint64 secondsPerSlot;
        uint64 genesisTime;
    }

    struct Report {
        uint128 beaconBalance;
        uint128 beaconValidators;
    }

    struct ReportKind {
        Report report;
        uint256 count;
    }

    struct EpochData {
        uint256 reportsBitMask;
        ReportKind[] kinds;
    }

    /// ACL
    bytes32 constant public MANAGE_MEMBERS = keccak256("MANAGE_MEMBERS");
    bytes32 constant public MANAGE_QUORUM = keccak256("MANAGE_QUORUM");
    bytes32 constant public SET_BEACON_SPEC = keccak256("SET_BEACON_SPEC");

    /// @dev Maximum number of oracle committee members
    uint256 public constant MAX_MEMBERS = 256;

    uint256 internal constant MEMBER_NOT_FOUND = uint256(-1);

    /// @dev oracle committee members
    address[] private members;
    /// @dev number of the committee members required to finalize a data point
    bytes32 internal constant QUORUM_POSITION = keccak256("lido.LidoOracle.quorum");

    /// @dev link to the Lido contract
    bytes32 internal constant LIDO_POSITION = keccak256("lido.LidoOracle.lido");

    /// @dev storage for actual beacon chain specs
    bytes32 internal constant BEACON_SPEC_POSITION = keccak256("lido.LidoOracle.beaconSpec");

    /// @dev the most early epoch that can be reported
    bytes32 internal constant MIN_REPORTABLE_EPOCH_ID_POSITION = keccak256("lido.LidoOracle.minReportableEpochId");
    /// @dev the max id of reported epochs
    bytes32 internal constant MAX_REPORTED_EPOCH_ID_POSITION = keccak256("lido.LidoOracle.maxReportedEpochId");
    /// @dev storage for all gathered from reports data
    mapping(uint256 => EpochData) private gatheredEpochData;
    /// @dev historic data about 2 last completed reports
    bytes32 internal constant POST_COMPLETED_TOTAL_POOLED_ETHER_POSITION =
        keccak256("lido.LidoOracle.postCompletedTotalPooledEther");
    bytes32 internal constant PRE_COMPLETED_TOTAL_POOLED_ETHER_POSITION =
        keccak256("lido.LidoOracle.preCompletedTotalPooledEther");
    bytes32 internal constant LAST_COMPLETED_EPOCH_ID_POSITION = keccak256("lido.LidoOracle.lastCompletedEpochId");
    bytes32 internal constant PREV_COMPLETED_EPOCH_ID_POSITION = keccak256("lido.LidoOracle.prevCompletedEpochId");

    function initialize(
        address _lido,
        uint64 _epochsPerFrame,
        uint64 _slotsPerEpoch,
        uint64 _secondsPerSlot,
        uint64 _genesisTime
    )
        public onlyInit
    {
        assert(1 == ((1 << (MAX_MEMBERS - 1)) >> (MAX_MEMBERS - 1)));  // static assert

        _setBeaconSpec(
            _epochsPerFrame,
            _slotsPerEpoch,
            _secondsPerSlot,
            _genesisTime
        );

        LIDO_POSITION.setStorageAddress(_lido);

        QUORUM_POSITION.setStorageUint256(1);
        emit QuorumChanged(1);

        initialized();
    }

    /**
      * @notice Add `_member` to the oracle member committee
      * @param _member Address of a member to add
      */
    function addOracleMember(address _member) external auth(MANAGE_MEMBERS) {
        require(members.length < MAX_MEMBERS, "TOO_MANY_MEMBERS");
        require(address(0) != _member, "BAD_ARGUMENT");
        require(MEMBER_NOT_FOUND == _getMemberId(_member), "MEMBER_EXISTS");

        members.push(_member);

        emit MemberAdded(_member);
        _assertInvariants();
    }

    /**
     * @notice Remove `_member` from the oracle member committee
     * @param _member Address of a member to remove
     */
    function removeOracleMember(address _member) external auth(MANAGE_MEMBERS) {
        uint256 index = _getMemberId(_member);
        require(index != MEMBER_NOT_FOUND, "MEMBER_NOT_FOUND");
        uint256 last = members.length.sub(1);
        if (index != last) members[index] = members[last];
        members.length--;
        emit MemberRemoved(_member);

        uint256 maxReportedEpochId = MAX_REPORTED_EPOCH_ID_POSITION.getStorageUint256();
        uint256 minReportableEpochId = MIN_REPORTABLE_EPOCH_ID_POSITION.getStorageUint256();
        if (maxReportedEpochId != minReportableEpochId) {
            MIN_REPORTABLE_EPOCH_ID_POSITION.setStorageUint256(maxReportedEpochId);
            emit MinReportableEpochIdUpdated(maxReportedEpochId);
        }

        // Nullify the data for the last epoch. Remained oracles will report it again
        delete gatheredEpochData[maxReportedEpochId];

        _assertInvariants();
    }

    /**
     * @notice Set the number of oracle members required to form a data point to `_quorum`
     */
    function setQuorum(uint256 _quorum) external auth(MANAGE_QUORUM) {
        require(0 != _quorum, "QUORUM_WONT_BE_MADE");

        QUORUM_POSITION.setStorageUint256(_quorum);
        emit QuorumChanged(_quorum);

        uint256 minReportableEpochId = MIN_REPORTABLE_EPOCH_ID_POSITION.getStorageUint256();
        uint256 maxReportedEpochId = MAX_REPORTED_EPOCH_ID_POSITION.getStorageUint256();

        assert(maxReportedEpochId <= getCurrentEpochId());

        if (maxReportedEpochId >= minReportableEpochId) {
            bool pushed = members.length > 0 && _tryPush(maxReportedEpochId);
            if (!pushed && maxReportedEpochId != minReportableEpochId) {
                MIN_REPORTABLE_EPOCH_ID_POSITION.setStorageUint256(maxReportedEpochId);
                emit MinReportableEpochIdUpdated(maxReportedEpochId);
            }
        }

        _assertInvariants();
    }

    /**
     * @notice An oracle committee member reports data from the ETH 2.0 side
     * @param _epochId BeaconChain epoch id
     * @param _beaconBalance Balance in wei on the ETH 2.0 side
     * @param _beaconValidators Number of validators visible on this epoch
     */
    function reportBeacon(uint256 _epochId, uint128 _beaconBalance, uint128 _beaconValidators) external {
        (uint256 startEpoch, uint256 endEpoch) = getCurrentReportableEpochs();
        require(_epochId >= startEpoch, "EPOCH_IS_TOO_OLD");
        require(_epochId <= endEpoch, "EPOCH_HAS_NOT_YET_BEGUN");

        address member = msg.sender;
        uint256 index = _getMemberId(member);
        require(index != MEMBER_NOT_FOUND, "MEMBER_NOT_FOUND");

        // check & set contribution flag
        EpochData storage epochData = gatheredEpochData[_epochId];
        uint256 bitMask = epochData.reportsBitMask;
        require(!bitMask.getBit(index), "ALREADY_SUBMITTED");
        epochData.reportsBitMask = bitMask.setBit(index, true);

        if (_epochId > MAX_REPORTED_EPOCH_ID_POSITION.getStorageUint256()) {
            MAX_REPORTED_EPOCH_ID_POSITION.setStorageUint256(_epochId);
        }

        uint256 i = 0;
        Report memory report = Report(_beaconBalance, _beaconValidators);
        uint256 reportRaw = reportToUint256(report);
        while (i < epochData.kinds.length && reportToUint256(epochData.kinds[i].report) != reportRaw) ++i;
        if (i < epochData.kinds.length) {
            ++epochData.kinds[i].count;
        } else {
            epochData.kinds.push(ReportKind(report, 1));
        }
        emit BeaconReported(_epochId, _beaconBalance, _beaconValidators, member);

        _tryPush(_epochId);
    }

    /**
     * @notice Returns all needed to oracle daemons data
     */
    function getCurrentFrame()
        external view
        returns (
            uint256 frameEpochId,
            uint256 frameStartTime,
            uint256 frameEndTime
        )
    {
        BeaconSpec memory beaconSpec = _getBeaconSpec();
        uint64 genesisTime = beaconSpec.genesisTime;
        uint64 epochsPerFrame = beaconSpec.epochsPerFrame;
        uint64 secondsPerEpoch = beaconSpec.secondsPerSlot.mul(beaconSpec.slotsPerEpoch);

        frameEpochId = getCurrentEpochId().div(epochsPerFrame).mul(epochsPerFrame);
        frameStartTime = frameEpochId.mul(secondsPerEpoch).add(genesisTime);

        uint256 nextFrameEpochId = frameEpochId.div(epochsPerFrame).add(1).mul(epochsPerFrame);
        frameEndTime = nextFrameEpochId.mul(secondsPerEpoch).add(genesisTime).sub(1);
    }

    /**
     * @notice Returns the current oracle member committee
     */
    function getOracleMembers() external view returns (address[]) {
        return members;
    }

    /**
     * @notice Returns the Lido contract address
     */
    function getLido() public view returns (ILido) {
        return ILido(LIDO_POSITION.getStorageAddress());
    }

    /**
     * @notice Set beacon specs
     */
    function setBeaconSpec(
        uint64 _epochsPerFrame,
        uint64 _slotsPerEpoch,
        uint64 _secondsPerSlot,
        uint64 _genesisTime
    )
        public auth(SET_BEACON_SPEC)
    {
        _setBeaconSpec(
            _epochsPerFrame,
            _slotsPerEpoch,
            _secondsPerSlot,
            _genesisTime
        );
    }

    /**
     * @notice Returns beacon specs
     */
    function getBeaconSpec()
        public
        view
        returns (
            uint64 epochsPerFrame,
            uint64 slotsPerEpoch,
            uint64 secondsPerSlot,
            uint64 genesisTime
        )
    {
        BeaconSpec memory beaconSpec = _getBeaconSpec();
        return (
            beaconSpec.epochsPerFrame,
            beaconSpec.slotsPerEpoch,
            beaconSpec.secondsPerSlot,
            beaconSpec.genesisTime
        );
    }

    /**
     * @notice Returns the number of oracle members required to form a data point
     */
    function getQuorum() public view returns (uint256) {
        return QUORUM_POSITION.getStorageUint256();
    }

    /**
     * @notice Returns the epochId calculated from current timestamp
     */
    function getCurrentEpochId() public view returns (uint256) {
        BeaconSpec memory beaconSpec = _getBeaconSpec();
        return (
            _getTime()
            .sub(beaconSpec.genesisTime)
            .div(beaconSpec.slotsPerEpoch)
            .div(beaconSpec.secondsPerSlot)
        );
    }

    /**
     * @notice Returns the fisrt and last epochs that can be reported
     */
    function getCurrentReportableEpochs()
        public view
        returns (
            uint256 minReportableEpochId,
            uint256 maxReportableEpochId
        )
    {
        minReportableEpochId = (
            MIN_REPORTABLE_EPOCH_ID_POSITION.getStorageUint256()
        );
        return (minReportableEpochId, getCurrentEpochId());
    }

    /**
     * @notice Reports beacon balance and its change
     */
    function getLastCompletedReports()
        public view
        returns (
            uint256 postTotalPooledEther,
            uint256 preTotalPooledEther,
            uint256 timeElapsed
        )
    {
        BeaconSpec memory beaconSpec = _getBeaconSpec();
        postTotalPooledEther = POST_COMPLETED_TOTAL_POOLED_ETHER_POSITION.getStorageUint256();
        preTotalPooledEther = PRE_COMPLETED_TOTAL_POOLED_ETHER_POSITION.getStorageUint256();
        timeElapsed = (LAST_COMPLETED_EPOCH_ID_POSITION.getStorageUint256()
                       .sub(PREV_COMPLETED_EPOCH_ID_POSITION.getStorageUint256()))
            .mul(beaconSpec.slotsPerEpoch)
            .mul(beaconSpec.secondsPerSlot);
    }

    /**
     * @dev Sets beacon spec
     */
    function _setBeaconSpec(
        uint64 _epochsPerFrame,
        uint64 _slotsPerEpoch,
        uint64 _secondsPerSlot,
        uint64 _genesisTime
    )
        internal
    {
        require(_epochsPerFrame > 0, "BAD_EPOCHS_PER_FRAME");
        require(_slotsPerEpoch > 0, "BAD_SLOTS_PER_EPOCH");
        require(_secondsPerSlot > 0, "BAD_SECONDS_PER_SLOT");
        require(_genesisTime > 0, "BAD_GENESIS_TIME");

        uint256 data = (
            uint256(_epochsPerFrame) << 192 |
            uint256(_slotsPerEpoch) << 128 |
            uint256(_secondsPerSlot) << 64 |
            uint256(_genesisTime)
        );
        BEACON_SPEC_POSITION.setStorageUint256(data);
    }

    /**
     * @dev Returns beaconSpec struct
     */
    function _getBeaconSpec()
        internal
        view
        returns (BeaconSpec memory beaconSpec)
    {
        uint256 data = BEACON_SPEC_POSITION.getStorageUint256();
        beaconSpec.epochsPerFrame = uint64(data >> 192);
        beaconSpec.slotsPerEpoch = uint64(data >> 128);
        beaconSpec.secondsPerSlot = uint64(data >> 64);
        beaconSpec.genesisTime = uint64(data);
        return beaconSpec;
    }

    /**
     * @dev Returns if quorum reached and mode-value report
     * @return isQuorum - true, when quorum is reached, false otherwise
     * @return modeReport - valid mode-value report when quorum is reached, 0-data otherwise
     */
    function _getQuorumReport(uint256 _epochId) internal view returns (bool isQuorum, Report memory modeReport) {
        EpochData storage epochData = gatheredEpochData[_epochId];
        uint256 quorum = getQuorum();

        // check most frequent cases: all reports are the same or no reprts yet
        if (epochData.kinds.length == 1) {
            return (epochData.kinds[0].count >= quorum, epochData.kinds[0].report);
        } else if (epochData.kinds.length == 0) {
            return (false, Report({beaconBalance: 0, beaconValidators: 0}));
        }

        // if more than 2 kind of reports exist, choose the most frequent
        uint256 maxi = 0;
        for (uint256 i = 1; i < epochData.kinds.length; ++i) {
            if (epochData.kinds[i].count > epochData.kinds[maxi].count) maxi = i;
        }
        for (i = 0; i < epochData.kinds.length; ++i) {
            if (i != maxi && epochData.kinds[i].count == epochData.kinds[maxi].count) {
                return (false, Report({beaconBalance: 0, beaconValidators: 0}));
            }
        }
        return (epochData.kinds[maxi].count >= quorum, epochData.kinds[maxi].report);
    }

    /**
     * @dev Pushes the current data point if quorum is reached
     */
    function _tryPush(uint256 _epochId) internal returns(bool) {
        (bool isQuorum, Report memory modeReport) = _getQuorumReport(_epochId);
        if (!isQuorum)
            return false;

        // data for this frame is collected, now this frame is completed, so
        // minReportableEpochId should be changed to first epoch from next frame
        BeaconSpec memory beaconSpec = _getBeaconSpec();
        uint256 minReportableEpochId =
            _epochId
            .div(beaconSpec.epochsPerFrame)
            .add(1)
            .mul(beaconSpec.epochsPerFrame);
        MIN_REPORTABLE_EPOCH_ID_POSITION.setStorageUint256(minReportableEpochId);
        emit MinReportableEpochIdUpdated(minReportableEpochId);
        emit Completed(_epochId, modeReport.beaconBalance, modeReport.beaconValidators);

        ILido lido = getLido();
        PRE_COMPLETED_TOTAL_POOLED_ETHER_POSITION.setStorageUint256(ISTETH(lido).totalSupply());
        lido.pushBeacon(modeReport.beaconValidators, modeReport.beaconBalance);
        POST_COMPLETED_TOTAL_POOLED_ETHER_POSITION.setStorageUint256(ISTETH(lido).totalSupply());
        PREV_COMPLETED_EPOCH_ID_POSITION.setStorageUint256(LAST_COMPLETED_EPOCH_ID_POSITION.getStorageUint256());
        LAST_COMPLETED_EPOCH_ID_POSITION.setStorageUint256(_epochId);
        delete gatheredEpochData[_epochId];
        return true;
    }

    function reportToUint256(Report _report) internal pure returns (uint256) {
        return uint256(_report.beaconBalance) << 128 | uint256(_report.beaconValidators);
    }

    function uint256ToReport(uint256 _report) internal pure returns (Report) {
        Report memory report;
        report.beaconBalance = uint128(_report >> 128);
        report.beaconValidators = uint128(_report);
        return report;
    }


    /**
     * @dev Returns member's index in the members array or MEMBER_NOT_FOUND
     */
    function _getMemberId(address _member) internal view returns (uint256) {
        uint256 length = members.length;
        for (uint256 i = 0; i < length; ++i) {
            if (members[i] == _member) {
                return i;
            }
        }
        return MEMBER_NOT_FOUND;
    }


    /**
     * @dev Returns current timestamp
     */
    function _getTime() internal view returns (uint256) {
        return block.timestamp; // solhint-disable-line not-rely-on-time
    }

    /**
     * @dev Checks code self-consistency
     */
    function _assertInvariants() private view {
        uint256 quorum = getQuorum();
        assert(quorum != 0);
        assert(members.length <= MAX_MEMBERS);
    }
}
