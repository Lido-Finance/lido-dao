import { abi as spsAbi } from '../../../../artifacts/NodeOperatorsRegistry.json'
import { encodeCallScript } from '@aragon/contract-helpers-test/src/aragon-os'
import { createVote, voteForAction } from './votingHelper'
import { BN, concatKeys, ETH } from '../utils'
import { SP_BASIC_FEE } from '../constants'
import logger from '../logger'

let web3
let context
export let stakingProviderContract

export function init(c) {
  if (!context) {
    context = c
    web3 = context.web3
    stakingProviderContract = new web3.eth.Contract(spsAbi, getProxyAddress())
  }
}

export function getProxyAddress() {
  return context.apps.stakingProvidersApp.proxyAddress
}

export async function hasInitialized() {
  return await stakingProviderContract.methods.hasInitialized().call()
}

export async function reportStoppedValidator(spId, incerment, sender) {
  return await stakingProviderContract.methods.reportStoppedValidators(spId, incerment).send({ from: sender, gas: '1000000' })
}

export async function setStakingProviderActive(spId, status, sender) {
  await stakingProviderContract.methods.setStakingProviderActive(spId, status).send({ from: sender, gas: '1000000' })
}

export async function setStakingProviderName(spId, name, sender) {
  await stakingProviderContract.methods.setStakingProviderName(spId, name).send({ from: sender, gas: '1000000' })
}

export async function setStakingProviderRewardAddress(spId, rewardAddress, sender) {
  await stakingProviderContract.methods.setStakingProviderRewardAddress(spId, rewardAddress).send({ from: sender, gas: '1000000' })
}

export async function setStakingProviderStakingLimit(spId, limit, sender) {
  await stakingProviderContract.methods.setStakingProviderStakingLimit(spId, limit).send({ from: sender, gas: '1000000' })
}

export async function addNodeOperator(name, member, stakingLimit, holder, holders) {
  const callData1 = encodeCallScript([
    {
      to: getProxyAddress(),
      calldata: await stakingProviderContract.methods.addNodeOperator(name, member, stakingLimit).encodeABI()
    }
  ])

  const voteId = await createVote(callData1, holder, 'Add staking provider - ' + name)
  return await voteForAction(voteId, holders, 'Add staking provider - ' + name)
}

export async function addSigningKeys(spId, validatorsTestData, holder, holders) {
  const validatorsPubKeys = concatKeys(validatorsTestData.pubKeys)
  const validatorsSignatures = concatKeys(validatorsTestData.signatures)
  // logger.debug('PubKeys to add ' + validatorsPubKeys)
  // logger.debug('Signatures to add' + validatorsSignatures)
  // TODO can be replaced without vote
  const callData1 = encodeCallScript([
    {
      to: getProxyAddress(),
      calldata: await stakingProviderContract.methods
        .addSigningKeys(spId, validatorsTestData.pubKeys.length, validatorsPubKeys, validatorsSignatures)
        .encodeABI()
    }
  ])

  const voteId = await createVote(callData1, holder, 'Add signing keys')
  return await voteForAction(voteId, holders, 'Add signing keys')
}

export async function addSigningKeysOperatorBH(spId, validatorsTestData, spMember) {
  const validatorsPubKeys = concatKeys(validatorsTestData.pubKeys)
  const validatorsSignatures = concatKeys(validatorsTestData.signatures)
  // logger.debug('PubKeys to add ' + validatorsPubKeys)
  // logger.debug('Signatures to add' + validatorsSignatures)
  return await stakingProviderContract.methods
    .addSigningKeysOperatorBH(spId, validatorsTestData.pubKeys.length, validatorsPubKeys, validatorsSignatures)
    .send({ from: spMember, gas: '10000000' })
}

export async function getUnusedSigningKeyCount(spId) {
  return await stakingProviderContract.methods.getUnusedSigningKeyCount(spId).call()
}

export async function getNodeOperator(spId, fullInfo = true) {
  return await stakingProviderContract.methods.getNodeOperator(spId, fullInfo).call()
}
export async function getSigningKey(spId, signingKeyId) {
  return await stakingProviderContract.methods.getSigningKey(spId, signingKeyId).call()
}

export async function getAllSigningKeys(sp, spId) {
  const signingKeysCount = sp.totalSigningKeys
  const pubKeys = []
  const signatures = []
  for (let i = 0; i < signingKeysCount; i++) {
    const signingKeyInfo = await getSigningKey(spId, i)
    pubKeys.push(signingKeyInfo.key)
    signatures.push(signingKeyInfo.depositSignature)
  }
  return {
    pubKeys,
    signatures
  }
}

export async function getNodeOperatorsCount() {
  return await stakingProviderContract.methods.getNodeOperatorsCount().call()
}

export async function getActiveSigningKeys(sp, spSigningKeys) {
  const usedSigningKeysCount = sp.usedSigningKeys
  const activeSigningKeys = []
  for (let i = 0; i < usedSigningKeysCount; i++) {
    activeSigningKeys.push(spSigningKeys.pubKeys[i])
  }
  return activeSigningKeys
}

export async function getActiveStakingProvidersCount() {
  return await stakingProviderContract.methods.getActiveStakingProvidersCount().call()
}

export async function getTotalSigningKeyCount(spId) {
  return await stakingProviderContract.methods.getTotalSigningKeyCount(spId).call()
}

export function calculateSpReward(spActiveSigningKeysCount, stakeProfit, totalUsedSigningKeysCount) {
  return BN(stakeProfit)
    .mul(BN(ETH(+spActiveSigningKeysCount)))
    .mul(BN(SP_BASIC_FEE / 100))
    .div(BN(ETH(+totalUsedSigningKeysCount)))
    .div(BN(100))
}

export function calculateNewSpBalance(sp, stakeProfit, totalUsedSigningKeysCount, balanceBeforePushData) {
  const spActiveSigningKeys = +sp.usedSigningKeys - +sp.stoppedValidators
  const reward = calculateSpReward(spActiveSigningKeys, stakeProfit, totalUsedSigningKeysCount)
  return BN(balanceBeforePushData).add(BN(reward)).toString()
}

export async function getTotalActiveKeysCount() {
  let effectiveStakeTotal = ''
  for (let spId = 0; spId < (await getNodeOperatorsCount()); spId++) {
    const sp = await getNodeOperator(spId, true)
    if (!sp.active) continue

    const effectiveStake = +sp.usedSigningKeys - +sp.stoppedValidators
    effectiveStakeTotal = +effectiveStakeTotal + +effectiveStake
  }
  return effectiveStakeTotal.toString()
}
