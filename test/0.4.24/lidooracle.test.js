const { assert } = require('chai')
const { newDao, newApp } = require('./helpers/dao')
const { assertBn, assertRevert, assertEvent } = require('@aragon/contract-helpers-test/src/asserts')

const LidoOracle = artifacts.require('LidoOracleMock.sol')
const Lido = artifacts.require('LidoMockForOracle.sol')
const QuorumCallback = artifacts.require('QuorumCallbackMock.sol')

// initial pooled ether (it's required to smooth increase of balance
// if you jump from 30 to 60 in one epoch it's a huge annual relative jump over 9000%
// but if you jump from 1e12+30 to 1e12+60 then it's smooth small jump as in the real world.
const START_BALANCE = 1e12

contract('LidoOracle', ([appManager, voting, user1, user2, user3, user4, nobody]) => {
  let appBase, appLido, app

  const assertReportableEpochs = async (startEpoch, endEpoch) => {
    const result = await app.getCurrentReportableEpochs()
    assertBn(result.minReportableEpochId, startEpoch)
    assertBn(result.maxReportableEpochId, endEpoch)
  }

  before('deploy base app', async () => {
    // Deploy the app's base contract.
    appBase = await LidoOracle.new()
    appLido = await Lido.new()
  })

  beforeEach('deploy dao and app', async () => {
    const { dao, acl } = await newDao(appManager)

    // Instantiate a proxy for the app, using the base contract as its logic implementation.
    const proxyAddress = await newApp(dao, 'lidooracle', appBase.address, appManager)
    app = await LidoOracle.at(proxyAddress)

    // Set up the app's permissions.
    await acl.createPermission(voting, app.address, await app.MANAGE_MEMBERS(), appManager, { from: appManager })
    await acl.createPermission(voting, app.address, await app.MANAGE_QUORUM(), appManager, { from: appManager })
    await acl.createPermission(voting, app.address, await app.SET_BEACON_SPEC(), appManager, { from: appManager })
    await acl.createPermission(voting, app.address, await app.SET_REPORT_BOUNDARIES(), appManager, { from: appManager })
    await acl.createPermission(voting, app.address, await app.SET_QUORUM_CALLBACK(), appManager, { from: appManager })

    // Initialize the app's proxy.
    await app.initialize(appLido.address, 1, 32, 12, 1606824000)
  })

  it('beaconSpec is correct', async () => {
    const beaconSpec = await app.getBeaconSpec()
    assertBn(beaconSpec.epochsPerFrame, 1)
    assertBn(beaconSpec.slotsPerEpoch, 32)
    assertBn(beaconSpec.secondsPerSlot, 12)
    assertBn(beaconSpec.genesisTime, 1606824000)
  })

  it('setBeaconSpec works', async () => {
    await assertRevert(app.setBeaconSpec(0, 1, 1, 1, { from: voting }), 'BAD_EPOCHS_PER_FRAME')
    await assertRevert(app.setBeaconSpec(1, 0, 1, 1, { from: voting }), 'BAD_SLOTS_PER_EPOCH')
    await assertRevert(app.setBeaconSpec(1, 1, 0, 1, { from: voting }), 'BAD_SECONDS_PER_SLOT')
    await assertRevert(app.setBeaconSpec(1, 1, 1, 0, { from: voting }), 'BAD_GENESIS_TIME')

    const receipt = await app.setBeaconSpec(1, 1, 1, 1, { from: voting })
    assertEvent(receipt, 'BeaconSpecSet', {
      expectedArgs: {
        epochsPerFrame: 1,
        slotsPerEpoch: 1,
        secondsPerSlot: 1,
        genesisTime: 1
      }
    })
    const beaconSpec = await app.getBeaconSpec()
    assertBn(beaconSpec.epochsPerFrame, 1)
    assertBn(beaconSpec.slotsPerEpoch, 1)
    assertBn(beaconSpec.secondsPerSlot, 1)
    assertBn(beaconSpec.genesisTime, 1)
  })

  describe('Test utility functions:', function () {
    it('addOracleMember works', async () => {
      await app.setTime(1606824000)

      await assertRevert(app.addOracleMember(user1, { from: user1 }), 'APP_AUTH_FAILED')
      await assertRevert(app.addOracleMember('0x0000000000000000000000000000000000000000', { from: voting }), 'BAD_ARGUMENT')

      await app.addOracleMember(user1, { from: voting })
      await assertRevert(app.addOracleMember(user2, { from: user2 }), 'APP_AUTH_FAILED')
      await assertRevert(app.addOracleMember(user3, { from: user2 }), 'APP_AUTH_FAILED')

      await app.addOracleMember(user2, { from: voting })
      await app.addOracleMember(user3, { from: voting })

      await assertRevert(app.addOracleMember(user1, { from: voting }), 'MEMBER_EXISTS')
      await assertRevert(app.addOracleMember(user2, { from: voting }), 'MEMBER_EXISTS')
    })

    it('removeOracleMember works', async () => {
      await app.setTime(1606824000)
      await app.addOracleMember(user1, { from: voting })

      await assertRevert(app.removeOracleMember(user1, { from: user1 }), 'APP_AUTH_FAILED')
      await app.removeOracleMember(user1, { from: voting })

      await app.addOracleMember(user1, { from: voting })
      await app.addOracleMember(user2, { from: voting })
      await app.addOracleMember(user3, { from: voting })

      await assertRevert(app.removeOracleMember(nobody, { from: voting }), 'MEMBER_NOT_FOUND')

      await app.removeOracleMember(user1, { from: voting })
      await app.removeOracleMember(user2, { from: voting })

      await assertRevert(app.removeOracleMember(user2, { from: user1 }), 'APP_AUTH_FAILED')

      assert.deepStrictEqual(await app.getOracleMembers(), [user3])
    })

    it('removeOracleMember updates reportableEpochId', async () => {
      await app.setTime(1606824000)
      await app.addOracleMember(user1, { from: voting })
      await app.addOracleMember(user2, { from: voting })
      await app.addOracleMember(user3, { from: voting })

      await app.setQuorum(2, { from: voting })

      await app.reportBeacon(0, 0, 0, { from: user1 })

      await app.setTime(1606824000 + 32 * 12 * 1)
      await assertReportableEpochs(0, 1)
      await app.reportBeacon(1, 0, 0, { from: user1 })

      await app.setTime(1606824000 + 32 * 12 * 2)
      await assertReportableEpochs(1, 2)
      await app.reportBeacon(2, 0, 0, { from: user1 })

      await assertReportableEpochs(2, 2)
      await app.removeOracleMember(user1, { from: voting })
      await assertReportableEpochs(2, 2)
    })

    it('setQuorum works', async () => {
      await app.setTime(1606824000)

      await app.addOracleMember(user1, { from: voting })
      await app.addOracleMember(user2, { from: voting })
      await app.addOracleMember(user3, { from: voting })

      await assertRevert(app.setQuorum(2, { from: user1 }), 'APP_AUTH_FAILED')
      await assertRevert(app.setQuorum(0, { from: voting }), 'QUORUM_WONT_BE_MADE')
      await app.setQuorum(4, { from: voting })

      await app.setQuorum(3, { from: voting })
      assertBn(await app.getQuorum(), 3)
    })

    it('setQuorum updates reportableEpochId and tries to push', async () => {
      let receipt

      await app.setTime(1606824000)

      await app.addOracleMember(user1, { from: voting })
      await app.addOracleMember(user2, { from: voting })
      await app.addOracleMember(user3, { from: voting })

      await app.setQuorum(4, { from: voting })

      await app.reportBeacon(0, 31, 1, { from: user1 })
      await app.reportBeacon(0, 32, 1, { from: user2 })
      await app.reportBeacon(0, 32, 1, { from: user3 })
      await assertReportableEpochs(0, 0)

      receipt = await app.setQuorum(3, { from: voting })
      await assertReportableEpochs(0, 0)

      receipt = await app.setQuorum(2, { from: voting })
      assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: 32, beaconValidators: 1 } })
      await assertReportableEpochs(1, 0)
    })

    it('getCurrentOraclesReportStatus/KindsSize/Kind', async () => {
      await app.setTime(1606824000)
      await app.addOracleMember(user1, { from: voting })
      await app.addOracleMember(user2, { from: voting })
      await app.addOracleMember(user3, { from: voting })
      await app.setQuorum(4, { from: voting })

      assertBn(await app.getCurrentOraclesReportStatus(), 0b000)
      assertBn(await app.getCurrentReportKindsSize(), 0)

      await app.reportBeacon(0, 100, 10, { from: user1 })
      assertBn(await app.getCurrentOraclesReportStatus(), 0b001)
      assertBn(await app.getCurrentReportKindsSize(), 1)

      await app.reportBeacon(0, 101, 11, { from: user2 })
      assertBn(await app.getCurrentOraclesReportStatus(), 0b011)
      assertBn(await app.getCurrentReportKindsSize(), 2)

      await app.reportBeacon(0, 100, 10, { from: user3 })
      assertBn(await app.getCurrentOraclesReportStatus(), 0b111)
      assertBn(await app.getCurrentReportKindsSize(), 2)

      const firstKind = await app.getCurrentReportKind(0)
      assertBn(firstKind.beaconBalance, 100)
      assertBn(firstKind.beaconValidators, 10)
      assertBn(firstKind.count, 2)
      const secondKind = await app.getCurrentReportKind(1)
      assertBn(secondKind.beaconBalance, 101)
      assertBn(secondKind.beaconValidators, 11)
      assertBn(secondKind.count, 1)

      await assertReportableEpochs(0, 0)

      const receipt = await app.setQuorum(2, { from: voting })
      assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: 100, beaconValidators: 10 } })
      await assertReportableEpochs(1, 0)
      assertBn(await app.getCurrentOraclesReportStatus(), 0b000)
      assertBn(await app.getCurrentReportKindsSize(), 0)
    })

    it('getOracleMembers works', async () => {
      await app.setTime(1606824000)

      await app.addOracleMember(user1, { from: voting })
      await app.addOracleMember(user2, { from: voting })
      await app.addOracleMember(user3, { from: voting })

      assert.deepStrictEqual(await app.getOracleMembers(), [user1, user2, user3])

      await app.removeOracleMember(user1, { from: voting })

      assert.deepStrictEqual(await app.getOracleMembers(), [user3, user2])
    })

    it('getCurrentEpochId works', async () => {
      await app.setTime(1606824000)
      assertBn(await app.getCurrentEpochId(), 0)
      await app.setTime(1606824000 + 32 * 12 - 1)
      assertBn(await app.getCurrentEpochId(), 0)
      await app.setTime(1606824000 + 32 * 12 * 123 + 1)
      assertBn(await app.getCurrentEpochId(), 123)
    })

    it('getCurrentReportableEpochs works', async () => {
      let result

      await app.setTime(1606824000)
      result = await app.getCurrentReportableEpochs()
      assertBn(result.minReportableEpochId, 0)
      assertBn(result.maxReportableEpochId, 0)

      await app.setTime(1606824000 + 32 * 12 - 1)
      result = await app.getCurrentReportableEpochs()
      assertBn(result.minReportableEpochId, 0)
      assertBn(result.maxReportableEpochId, 0)

      await app.setTime(1606824000 + 32 * 12 * 123 + 1)
      result = await app.getCurrentReportableEpochs()
      assertBn(result.minReportableEpochId, 0)
      assertBn(result.maxReportableEpochId, 123)
    })

    it('getCurrentFrame works', async () => {
      await app.setBeaconSpec(10, 32, 12, 1606824000, { from: voting })

      let result

      await app.setTime(1606824000)
      result = await app.getCurrentFrame()
      assertBn(result.frameEpochId, 0)
      assertBn(result.frameStartTime, 1606824000)
      assertBn(result.frameEndTime, 1606824000 + 32 * 12 * 10 - 1)

      await app.setTime(1606824000 + 32 * 12 * 10 - 1)
      result = await app.getCurrentFrame()
      assertBn(result.frameEpochId, 0)
      assertBn(result.frameStartTime, 1606824000)
      assertBn(result.frameEndTime, 1606824000 + 32 * 12 * 10 - 1)

      await app.setTime(1606824000 + 32 * 12 * 123)
      result = await app.getCurrentFrame()
      assertBn(result.frameEpochId, 120)
      assertBn(result.frameStartTime, 1606824000 + 32 * 12 * 120)
      assertBn(result.frameEndTime, 1606824000 + 32 * 12 * 130 - 1)
    })
  })

  describe('When there is single-member setup', function () {
    describe('current time: 1606824000, current epoch: 0', function () {
      beforeEach(async () => {
        await app.setTime(1606824000)
        await app.addOracleMember(user1, { from: voting })
        assertBn(await app.getQuorum(), 1)

        await app.setAllowedBeaconBalanceAnnualRelativeIncrease(100000, { from: voting }) // default value from contract
        await app.setAllowedBeaconBalanceRelativeDecrease(50000, { from: voting }) // default value from contract
      })

      it('reverts when trying to report from non-member', async () => {
        for (const account of [user2, user3, user4, nobody])
          await assertRevert(app.reportBeacon(0, 32, 1, { from: account }), 'MEMBER_NOT_FOUND')
      })

      it('reportBeacon works and emits event, getLastCompletedReportDelta tracks last 2 reports', async () => {
        await app.reportBeacon(0, START_BALANCE, 1, { from: user1 })

        await app.setTime(1606824000 + 32 * 12 * 1) // 1 epoch later
        const prePooledEther = START_BALANCE + 32
        let receipt = await app.reportBeacon(1, prePooledEther, 1, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 1, beaconBalance: prePooledEther, beaconValidators: 1 } })
        assertEvent(receipt, 'PostTotalShares', {
          expectedArgs: {
            postTotalPooledEther: prePooledEther,
            preTotalPooledEther: START_BALANCE,
            timeElapsed: 32 * 12 * 1,
            totalShares: 42
          }
        })
        await assertReportableEpochs(2, 1)

        let res = await app.getLastCompletedReportDelta()
        assertBn(res.postTotalPooledEther, prePooledEther)
        assertBn(res.preTotalPooledEther, START_BALANCE)
        assertBn(res.timeElapsed, 32 * 12 * 1)

        await app.setTime(1606824000 + 32 * 12 * 3) // 2 epochs later
        const postPooledEther = prePooledEther + 99
        receipt = await app.reportBeacon(3, postPooledEther, 3, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 3, beaconBalance: postPooledEther, beaconValidators: 3 } })
        assertEvent(receipt, 'PostTotalShares', {
          expectedArgs: {
            postTotalPooledEther: postPooledEther,
            preTotalPooledEther: prePooledEther,
            timeElapsed: 32 * 12 * 2,
            totalShares: 42
          }
        })
        await assertReportableEpochs(4, 3)

        res = await app.getLastCompletedReportDelta()
        assertBn(res.postTotalPooledEther, postPooledEther)
        assertBn(res.preTotalPooledEther, prePooledEther)
        assertBn(res.timeElapsed, 32 * 12 * 2)
      })

      it('reportBeacon works OK on OK pooledEther increase', async () => {
        const beginPooledEther = START_BALANCE
        let receipt = await app.reportBeacon(0, beginPooledEther, 1, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: beginPooledEther, beaconValidators: 1 } })
        await assertReportableEpochs(1, 0)

        const reward = Math.round((START_BALANCE * (768 / 365 / 24 / 3600) * 9) / 100) // annual increase by 9%
        const nextPooledEther = beginPooledEther + reward
        await app.setTime(1606824000 + 32 * 12 * 2) // 2 epochs later (timeElapsed = 768)
        receipt = await app.reportBeacon(2, nextPooledEther, 3, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 2, beaconBalance: nextPooledEther, beaconValidators: 3 } })
      })

      it('reportBeacon reverts on too high pooledEther increase', async () => {
        const beginPooledEther = START_BALANCE
        const receipt = await app.reportBeacon(0, beginPooledEther, 1, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: beginPooledEther, beaconValidators: 1 } })
        await assertReportableEpochs(1, 0)

        const reward = Math.round((START_BALANCE * (768 / 365 / 24 / 3600) * 11) / 100) // annual increase by 11%
        const nextPooledEther = beginPooledEther + reward
        await app.setTime(1606824000 + 32 * 12 * 2) // 2 epochs later (timeElapsed = 768)
        await assertRevert(app.reportBeacon(2, nextPooledEther, 3, { from: user1 }), 'ALLOWED_BEACON_BALANCE_INCREASE')
      })

      it('reportBeacon works OK on OK pooledEther decrease', async () => {
        const beginPooledEther = START_BALANCE
        let receipt = await app.reportBeacon(0, beginPooledEther, 1, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: beginPooledEther, beaconValidators: 1 } })
        await assertReportableEpochs(1, 0)

        await app.setTime(1606824000 + 32 * 12 * 2) // 2 epochs later (timeElapsed = 768)
        const loss = Math.round((START_BALANCE * 4) / 100) // decrease by 4%
        const nextPooledEther = beginPooledEther - loss
        receipt = await app.reportBeacon(2, nextPooledEther, 3, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 2, beaconBalance: nextPooledEther, beaconValidators: 3 } })
      })

      it('reportBeacon reverts on too high pooledEther decrease', async () => {
        const beginPooledEther = START_BALANCE
        const receipt = await app.reportBeacon(0, beginPooledEther, 1, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: beginPooledEther, beaconValidators: 1 } })
        await assertReportableEpochs(1, 0)

        const loss = Math.round((START_BALANCE * 6) / 100) // decrease by 6%
        const nextPooledEther = beginPooledEther - loss
        await app.setTime(1606824000 + 32 * 12 * 2) // 2 epochs later (timeElapsed = 768)
        await assertRevert(app.reportBeacon(2, nextPooledEther, 3, { from: user1 }), 'ALLOWED_BEACON_BALANCE_DECREASE')
      })

      it('reportBeacon change increase limit works', async () => {
        let res = await app.setAllowedBeaconBalanceAnnualRelativeIncrease(42, { from: voting })
        assertEvent(res, 'AllowedBeaconBalanceAnnualRelativeIncreaseSet', { expectedArgs: { value: 42 } })
        let limit = await app.getAllowedBeaconBalanceAnnualRelativeIncrease()
        assertBn(limit, 42)

        res = await app.setAllowedBeaconBalanceAnnualRelativeIncrease(777, { from: voting })
        assertEvent(res, 'AllowedBeaconBalanceAnnualRelativeIncreaseSet', { expectedArgs: { value: 777 } })
        limit = await app.getAllowedBeaconBalanceAnnualRelativeIncrease()
        assertBn(limit, 777)
      })

      it('reportBeacon change decrease limit works', async () => {
        let res = await app.setAllowedBeaconBalanceRelativeDecrease(42, { from: voting })
        assertEvent(res, 'AllowedBeaconBalanceRelativeDecreaseSet', { expectedArgs: { value: 42 } })
        let limit = await app.getAllowedBeaconBalanceRelativeDecrease()
        assertBn(limit, 42)

        res = await app.setAllowedBeaconBalanceRelativeDecrease(777, { from: voting })
        assertEvent(res, 'AllowedBeaconBalanceRelativeDecreaseSet', { expectedArgs: { value: 777 } })
        limit = await app.getAllowedBeaconBalanceRelativeDecrease()
        assertBn(limit, 777)
      })

      it('reportBeacon change increase limit affect sanity checks', async () => {
        const beginPooledEther = START_BALANCE
        let receipt = await app.reportBeacon(0, beginPooledEther, 1, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: beginPooledEther, beaconValidators: 1 } })
        await assertReportableEpochs(1, 0)

        const reward = Math.round((START_BALANCE * (768 / 365 / 24 / 3600) * 11) / 100) // annual increase by 11%
        const nextPooledEther = beginPooledEther + reward
        await app.setTime(1606824000 + 32 * 12 * 2) // 2 epochs later (timeElapsed = 768)

        // check fails
        await assertRevert(app.reportBeacon(2, nextPooledEther, 3, { from: user1 }), 'ALLOWED_BEACON_BALANCE_INCREASE')

        // set limit up to 12%
        const res = await app.setAllowedBeaconBalanceAnnualRelativeIncrease(120000, { from: voting })
        assertEvent(res, 'AllowedBeaconBalanceAnnualRelativeIncreaseSet', { expectedArgs: { value: 120000 } })

        // check OK
        receipt = await app.reportBeacon(2, nextPooledEther, 3, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 2, beaconBalance: nextPooledEther, beaconValidators: 3 } })
      })

      it('reportBeacon change decrease limit affect sanity checks', async () => {
        const beginPooledEther = START_BALANCE
        let receipt = await app.reportBeacon(0, beginPooledEther, 1, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: beginPooledEther, beaconValidators: 1 } })
        await assertReportableEpochs(1, 0)

        const loss = Math.round((START_BALANCE * 6) / 100) // decrease by 6%
        const nextPooledEther = beginPooledEther - loss
        await app.setTime(1606824000 + 32 * 12 * 2) // 2 epochs later (timeElapsed = 768)

        // check fails
        await assertRevert(app.reportBeacon(2, nextPooledEther, 3, { from: user1 }), 'ALLOWED_BEACON_BALANCE_DECREASE')

        // set limit up to 7%
        const res = await app.setAllowedBeaconBalanceRelativeDecrease(70000, { from: voting })
        assertEvent(res, 'AllowedBeaconBalanceRelativeDecreaseSet', { expectedArgs: { value: 70000 } })

        // check OK
        receipt = await app.reportBeacon(2, nextPooledEther, 3, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 2, beaconBalance: nextPooledEther, beaconValidators: 3 } })
      })

      it('reportBeacon time affect increase sanity checks', async () => {
        const beginPooledEther = START_BALANCE
        let receipt = await app.reportBeacon(0, beginPooledEther, 1, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: beginPooledEther, beaconValidators: 1 } })
        await assertReportableEpochs(1, 0)

        const reward = Math.round((START_BALANCE * (768 / 365 / 24 / 3600) * 19) / 100) // annual increase by 19%
        const nextPooledEther = beginPooledEther + reward
        await app.setTime(1606824000 + 32 * 12 * 2) // 2 epochs later (timeElapsed = 768)

        // check fails
        await assertRevert(app.reportBeacon(2, nextPooledEther, 3, { from: user1 }), 'ALLOWED_BEACON_BALANCE_INCREASE')

        await app.setTime(1606824000 + 32 * 12 * 4) // 4 epochs later (timeElapsed = 768*2)
        // check OK because 4 epochs passed
        receipt = await app.reportBeacon(4, nextPooledEther, 3, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 4, beaconBalance: nextPooledEther, beaconValidators: 3 } })
      })

      it('reportBeacon time does not affect decrease sanity checks', async () => {
        const beginPooledEther = START_BALANCE
        const receipt = await app.reportBeacon(0, beginPooledEther, 1, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: beginPooledEther, beaconValidators: 1 } })
        await assertReportableEpochs(1, 0)

        const reward = Math.round(START_BALANCE * (6 / 100)) // annual increase by 6%
        const nextPooledEther = beginPooledEther + reward
        await app.setTime(1606824000 + 32 * 12 * 2) // 2 epochs later (timeElapsed = 768)

        // check fails
        await assertRevert(app.reportBeacon(2, nextPooledEther, 3, { from: user1 }), 'ALLOWED_BEACON_BALANCE_INCREASE')

        await app.setTime(1606824000 + 32 * 12 * 4) // 4 epochs later (timeElapsed = 768*2)
        // check fails but 4 epochs passed
        await assertRevert(app.reportBeacon(4, nextPooledEther, 3, { from: user1 }), 'ALLOWED_BEACON_BALANCE_INCREASE')
      })

      it('quorum delegate called with same arguments as getLatestCompletedReports', async () => {
        const mock = await QuorumCallback.new()
        let receipt = await app.setQuorumCallback(mock.address, { from: voting })
        assertEvent(receipt, 'QuorumCallbackSet', { expectedArgs: { callback: mock.address } })
        assert((await app.getQuorumCallback()) === mock.address)

        receipt = await app.reportBeacon(0, START_BALANCE + 35, 1, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: START_BALANCE + 35, beaconValidators: 1 } })
        await assertReportableEpochs(1, 0)

        await app.setTime(1606824000 + 32 * 12 * 2) // 3 epochs later
        receipt = await app.reportBeacon(2, START_BALANCE + 77, 3, { from: user1 })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 2, beaconBalance: START_BALANCE + 77, beaconValidators: 3 } })
        await assertReportableEpochs(3, 2)

        assertBn(await mock.postTotalPooledEther(), START_BALANCE + 77)
        assertBn(await mock.preTotalPooledEther(), START_BALANCE + 35)
        assertBn(await mock.timeElapsed(), 32 * 12 * 2)

        const res = await app.getLastCompletedReportDelta()
        assertBn(res.postTotalPooledEther, START_BALANCE + 77)
        assertBn(res.preTotalPooledEther, START_BALANCE + 35)
        assertBn(res.timeElapsed, 32 * 12 * 2)
      })

      it('reverts when trying to report this epoch again', async () => {
        await app.reportBeacon(0, 32, 1, { from: user1 })
        await assertReportableEpochs(1, 0)
        await assertRevert(app.reportBeacon(0, 32, 1, { from: user1 }), 'EPOCH_IS_TOO_OLD')
      })

      it('reverts when trying to report future epoch', async () => {
        await assertRevert(app.reportBeacon(1, 32, 1, { from: user1 }), 'UNEXPECTED_EPOCH')
      })

      describe(`current time: ${1606824000 + 32 * 12 * 5}, current epoch: 5`, function () {
        beforeEach(async () => {
          await app.reportBeacon(0, 32, 1, { from: user1 })
          await app.setTime(1606824000 + 32 * 12 * 5)
          await assertReportableEpochs(1, 5)
        })

        it('reverts when trying to report stale epoch', async () => {
          await assertRevert(app.reportBeacon(0, 32, 1, { from: user1 }), 'EPOCH_IS_TOO_OLD')
          await assertReportableEpochs(1, 5)
        })

        it('reportBeacon works and emits event', async () => {
          const receipt = await app.reportBeacon(5, 32, 1, { from: user1 })
          assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 5, beaconBalance: 32, beaconValidators: 1 } })
          await assertReportableEpochs(6, 5)
        })
      })
    })
  })

  describe('When there is multi-member setup (4 members)', function () {
    beforeEach(async () => {
      await app.setTime(1606824000)
      await app.addOracleMember(user1, { from: voting })
      await app.addOracleMember(user2, { from: voting })
      await app.addOracleMember(user3, { from: voting })
      await app.addOracleMember(user4, { from: voting })
    })

    describe('current time: 1606824000, current epoch: 0', function () {
      beforeEach(async () => {
        await app.setTime(1606824000)
        await app.setQuorum(3, { from: voting })
        assertBn(await app.getQuorum(), 3)
      })

      it('reverts when trying to report from non-member', async () => {
        await assertRevert(app.reportBeacon(0, 32, 1, { from: nobody }), 'MEMBER_NOT_FOUND')
      })

      it('reportBeacon works and emits event', async () => {
        let receipt

        receipt = await app.reportBeacon(0, 32, 1, { from: user1 })
        assertEvent(receipt, 'BeaconReported', { expectedArgs: { epochId: 0, beaconBalance: 32, beaconValidators: 1, caller: user1 } })
        await assertReportableEpochs(0, 0)

        receipt = await app.reportBeacon(0, 32, 1, { from: user2 })
        assertEvent(receipt, 'BeaconReported', { expectedArgs: { epochId: 0, beaconBalance: 32, beaconValidators: 1, caller: user2 } })
        await assertReportableEpochs(0, 0)

        receipt = await app.reportBeacon(0, 32, 1, { from: user3 })
        assertEvent(receipt, 'BeaconReported', { expectedArgs: { epochId: 0, beaconBalance: 32, beaconValidators: 1, caller: user3 } })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: 32, beaconValidators: 1 } })
        await assertReportableEpochs(1, 0)
      })

      it('reportBeacon completes only if data reaches quorum', async () => {
        let receipt

        await app.reportBeacon(0, START_BALANCE + 32, 1, { from: user1 })
        await assertReportableEpochs(0, 0)
        await app.reportBeacon(0, START_BALANCE + 65, 2, { from: user2 })
        await assertReportableEpochs(0, 0)
        await app.reportBeacon(0, START_BALANCE + 65, 2, { from: user3 }) // quorum is 3 here, not yet reached
        await assertReportableEpochs(0, 0)
        receipt = await app.reportBeacon(0, START_BALANCE + 65, 2, { from: user4 }) // quorum is reached
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 0, beaconBalance: START_BALANCE + 65, beaconValidators: 2 } })
        await assertReportableEpochs(1, 0)

        await app.setTime(1606824000 + 32 * 12) // 1 epoch
        await app.setQuorum(4, { from: voting })
        await assertReportableEpochs(1, 1)
        await app.reportBeacon(1, START_BALANCE + 64, 2, { from: user1 })
        await assertReportableEpochs(1, 1)
        await app.reportBeacon(1, START_BALANCE + 65, 2, { from: user2 })
        await assertReportableEpochs(1, 1)
        await app.reportBeacon(1, START_BALANCE + 97, 3, { from: user3 })
        await assertReportableEpochs(1, 1)
        await app.reportBeacon(1, START_BALANCE + 98, 3, { from: user4 }) // data is not unimodal, quorum is not reached
        await assertReportableEpochs(1, 1)

        await app.setTime(1606824000 + 32 * 12 * 2) // 2nd epoch
        await assertReportableEpochs(1, 2)

        await app.reportBeacon(2, START_BALANCE + 99, 3, { from: user1 })
        await assertReportableEpochs(2, 2)
        receipt = await app.setQuorum(1, { from: voting })
        assertEvent(receipt, 'Completed', { expectedArgs: { epochId: 2, beaconBalance: START_BALANCE + 99, beaconValidators: 3 } })
        await assertReportableEpochs(3, 2)
      })

      it('reverts when trying to report this epoch again', async () => {
        await app.reportBeacon(0, 32, 1, { from: user1 })
        await app.reportBeacon(0, 32, 1, { from: user2 })
        await app.reportBeacon(0, 32, 1, { from: user3 })

        for (const account of [user1, user2, user3, user4])
          await assertRevert(app.reportBeacon(0, 32, 1, { from: account }), 'EPOCH_IS_TOO_OLD')

        await assertReportableEpochs(1, 0)
      })

      it('reverts when trying to report this epoch again from the same user', async () => {
        await app.reportBeacon(0, 32, 1, { from: user1 })

        await assertRevert(app.reportBeacon(0, 32, 1, { from: user1 }), 'ALREADY_SUBMITTED')
        await assertReportableEpochs(0, 0)
      })

      it('reverts when trying to report future epoch', async () => {
        await assertRevert(app.reportBeacon(1, 32, 1, { from: user1 }), 'UNEXPECTED_EPOCH')
      })
    })
  })
})
