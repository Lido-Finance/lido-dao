/***
 * Inspired by & rewritten from: https://github.com/yushih/solidity-gas-profiler;
 * added support for multiple contracts (call, delegatecall, etc.), multiple sources
 * per contract (inheritance), and transactions/opcodes that construct new contracts.
 **/

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const chalk = require('chalk');
const binarysearch = require('binarysearch');
const Web3 = require('web3');
const BN = require('bn.js');

const makeSource = (id, fileName) => ({
  id,
  fileName,
  skip: false,
  text: null,
  lineOffsets: null,
  lineGas: [],
  linesWithCalls: {}
});

const makeContract = addressHexStr => ({
  addressHexStr: strip0x(addressHexStr.toLowerCase()),
  codeHexStr: null,
  constructionСodeHexStr: null,
  fileName: null,
  name: null,
  sourcesById: {},
  sourceMap: null,
  constructorSourceMap: null,
  pcToIdx: null,
  constructionPcToIdx: null,
  totalGasCost: 0,
  synthGasCost: 0
});

const makeCallStackItem = (contract, targetAddressHexStr) => ({
  contract,
  targetAddressHexStr: strip0x(targetAddressHexStr.toLowerCase()),
  isConstructionCall: false,
  gasBefore: 0,
  gasBeforeOutgoingCall: 0,
  outgoingCallSource: null,
  outgoingCallLine: null
})

const contractByAddr = {};
const sourceById = {};
const sourceByFilename = {};

const argv = yargs(yargs.hideBin(process.argv))
  .usage(
    '$0 <solc-output-json> <transaction-hash-or-dump>',
    'Display line-by-line gas usage of the given transaction',
    cmd => cmd
      .positional('solc-output-json', {
        describe: 'the file containing JSON generated by solc using its --standard-json flag',
        type: 'string'
      })
      .positional('transaction-hash-or-dump', {
        describe: 'hash of the transaction to profile',
        type: 'string'
      })
      .option('i', {
        alias: 'solc-input-json',
        type: 'string',
        describe: 'read sources from solc standard input JSON file'
      })
      .option('S', {
        alias: 'skip',
        type: 'array',
        default: [],
        describe: 'skip printing gas usage for filenames containing this substring'
      })
      .option('only-address', {
        type: 'string',
        describe: 'only report line gas usage within a contract with the given address'
      })
      .option('R', {
        alias: 'src-root',
        type: 'string',
        default: '.',
        describe: 'the directory relative to which the source paths inside <solc-output-json> file should be resolved'
      })
      .option('e', {
        alias: 'rpc-endpoint',
        type: 'string',
        default: 'http://localhost:8545',
        describe: 'JSON-RPC endpoint; should support the debug_traceTransaction method'
      })
      .option('dump-to', {
        type: 'string',
        default: null,
        describe: 'save the tx data and its trace log to a given file'
      })
  )
  .help()
  .strict()
  .argv;

main(argv)
  .catch(e => {
    console.error(e.stack);
    process.exit(2);
  })
  .then(success => {
    process.exit(success ? 0 : 1);
  });

async function main(argv) {
  const dump = tryReadJSONFile(argv.transactionHashOrDump);
  const isDump = !!dump;

  if (isDump && argv.dumpTo) {
    console.log(`Dumping the trace is only supported when not running from a dump`);
    return false;
  }

  if (!isDump && !isValidTransactionId(argv.transactionHashOrDump)) {
    console.log(`Dump file ${argv.transactionHashOrDump} not found`);
    return false;
  }

  const web3 = isDump ? null : getWeb3(argv.rpcEndpoint);
  const codeByAddr = isDump ? dump.codeByAddr : (argv.dumpTo ? {} : null);
  const txHash = isDump ? dump.tx.hash : argv.transactionHashOrDump;
  const solcOutput = JSON.parse(await readFile(argv.solcOutputJson));
  const solcInput = argv.solcInputJson
    ? JSON.parse(await readFile(argv.solcInputJson))
    : null;

  const sourceProvider = {
    skipFiles: argv.skip,
    getSourceFilename: makeGetSourceFilenameFromSolcOutputJson(solcOutput),
    readSource: solcInput
      ? makeReadSourceFromSolcInputJSON(solcInput)
      : makeReadSourceFromDisk(argv.srcRoot)
  };

  if (!isDump) {
    const clientVersion = await web3.getClientVersion();
    console.error(`Client version: ${clientVersion}\n`);
  }

  const [receipt, tx] = isDump
    ? [dump.receipt, dump.tx]
    : await Promise.all([
        web3.eth.getTransactionReceipt(txHash).catch(e => null),
        web3.eth.getTransaction(txHash).catch(e => null)
      ]);

  if (!tx || !receipt) {
    console.log(`Transaction not found`);
    return false;
  }

  const isEntryCallConstruction = !tx.to && !!receipt.contractAddress;
  const entryAddr = isEntryCallConstruction ? receipt.contractAddress : tx.to;
  assert(!!entryAddr);

  const onlyAddressHexStr = argv.onlyAddress
    ? strip0x(argv.onlyAddress.toLowerCase())
    : null;

  if (onlyAddressHexStr != null) {
    console.log(`Reporting line-by-line gas consumed only inside 0x${onlyAddressHexStr}`);
  }

  const entryContract = await getContractWithAddr(entryAddr, web3, solcOutput, isDump, codeByAddr);
  if (!entryContract.codeHexStr) {
    console.log(`Total gas used by transaction:`, receipt.gasUsed);
    console.log(`The transaction target address is not a contract`);
    return false;
  }

  console.log(`Entry contract address: ${entryAddr}`);
  !isDump && console.error(`Obtaining the trace...`);

  // https://github.com/ethereum/go-ethereum/wiki/Tracing:-Introduction
  const trace = isDump ? dump.trace : await web3.traceTx(txHash, {
    disableStack: false,
    disableMemory: true,
    disableStorage: true
  });

  !isDump && console.error(`Trace obtained`);

  const entryCall = makeCallStackItem(entryContract, entryAddr);
  entryCall.isConstructionCall = isEntryCallConstruction;

  const callStack = [entryCall];
  const bottomDepth = trace.structLogs[0].depth; // 1 in geth, 0 in ganache
  const initialGasCost = tx.gas - trace.structLogs[0].gas;

  for (let i = 0; i < trace.structLogs.length; ++i) {
    const prevLog = trace.structLogs[i - 1];
    const nextLog = trace.structLogs[i + 1];
    const log = trace.structLogs[i];
    const gasCost = getGasCost(log, nextLog);

    // console.error(`${log.op}, gas ${log.gas}, gasCost ${log.gasCost}, pc ${log.pc}, depth ${log.depth}`);

    while (log.depth - bottomDepth < callStack.length - 1) {
      const prevTopCall = callStack.pop();
      // Using the previous log since the current log's gas contains the compensation of 1/64 gas
      // that was held when making the call, and at the point when prevTopCall.gasBefore was
      // recorded this amount had been already held by the call instruction.
      prevTopCall.contract.totalGasCost += prevTopCall.gasBefore - prevLog.gas + getGasCost(prevLog, log);

      const topCall = callStack[callStack.length - 1];
      const cumulativeCallCost = topCall.gasBeforeOutgoingCall - log.gas;
      if (onlyAddressHexStr == null || topCall.targetAddressHexStr === onlyAddressHexStr) {
        increaseLineGasCost(topCall.outgoingCallSource, topCall.outgoingCallLine, cumulativeCallCost, true);
      }
    }

    assert(callStack.length > 0);

    const call = callStack[log.depth - bottomDepth];

    const sourceInfo = getSourceInfo(call, log);
    const {sourceId, isSynthOp} = sourceInfo;

    const source = sourceId != null
      ? sourceById[sourceId] || await getSourceWithId(sourceId, sourceProvider)
      : null;

    const line = source && source.lineOffsets
      ? binarysearch.closest(source.lineOffsets, sourceInfo.offset)
      : null;

    if (sourceId != null && call.contract.sourcesById[sourceId] === undefined) {
      call.contract.sourcesById[sourceId] = source;
    }

    if (i === 0 && line != null) {
      console.log(`Entry line: ${source.fileName}:${line + 1}`);
    }

    const outgoingCallTarget = getCallTarget(log, i, trace.structLogs);

    if (outgoingCallTarget.addressHexStr && nextLog && nextLog.depth > log.depth) {
      // the current instruction is a call or create instruction
      assert(nextLog.depth === log.depth + 1);

      call.outgoingCallSource = source;
      call.outgoingCallLine = line;
      call.gasBeforeOutgoingCall = log.gas;

      const targetContract = await getContractWithAddr(outgoingCallTarget.addressHexStr, web3, solcOutput, isDump, codeByAddr);
      const outgoingCall = makeCallStackItem(targetContract, outgoingCallTarget.addressHexStr);

      outgoingCall.isConstructionCall = outgoingCallTarget.isConstructionCall;
      outgoingCall.gasBefore = nextLog.gas; // here the 1/64 of the remaining gas will already be held

      callStack.push(outgoingCall);
    } else if (onlyAddressHexStr == null || call.targetAddressHexStr === onlyAddressHexStr) {
      if (isSynthOp) {
        call.contract.synthGasCost += gasCost;
      } else {
        increaseLineGasCost(source, line, gasCost, false);
      }
    }
  }

  if (argv.dumpTo) {
    console.error(`Dumping the trace...`);
    const data = JSON.stringify({tx, receipt, codeByAddr, trace});
    fs.writeFileSync(argv.dumpTo, data);
    console.error(`Done dumping the trace`);
    process.exit(0);
  }

  const firstLog = trace.structLogs[0];
  const lastLog = trace.structLogs[trace.structLogs.length - 1];
  entryContract.totalGasCost = firstLog.gas - lastLog.gas + getGasCost(lastLog);

  console.log(`Total gas used by transaction:`, receipt.gasUsed);
  console.log(`Initial gas cost (sending tx, data):`, initialGasCost);
  console.log(`Gas used by opcodes:`, entryContract.totalGasCost);
  console.log(`Other gas:`, receipt.gasUsed - initialGasCost - entryContract.totalGasCost);

  Object.keys(contractByAddr).forEach(addressHexStr => {
    const contract = contractByAddr[addressHexStr];
    if (contract.name == null) {
      console.log(`\nUnknown contract at 0x${addressHexStr}`);
    } else {
      const fileNames = Object.keys(contract.sourcesById)
        .map(id => contract.sourcesById[id])
        .map(source => source && source.fileName)
        .filter(x => !!x)
        .join(', ')
      console.log(`\nContract ${contract.name} at 0x${addressHexStr}`);
      console.log(`  defined in: ${fileNames || contract.fileName || '<no sources found>'}`);
      console.log('  synthetic instruction gas:', contract.synthGasCost);
    }
    console.log('  total gas spent in the contract:', contract.totalGasCost);
  });

  const souceFilenames = Object.keys(sourceByFilename);

  let maxGasPerLine = 0;
  let hasCalls = false;
  let hasGasByFilename = {}

  souceFilenames.forEach(fileName => {
    const source = sourceByFilename[fileName];
    let hasGas = false;
    source.lineGas.forEach((gasPerLine, iLine) => {
      if (!hasGas && gasPerLine > 0) {
        hasGas = true;
      }
      if (gasPerLine > maxGasPerLine) {
        maxGasPerLine = gasPerLine;
      }
      if (!hasCalls && source.linesWithCalls[iLine]) {
        hasCalls = true
      }
    })
    if (hasGas) {
      hasGasByFilename[fileName] = true;
    }
  });

  const gasColTitle = 'GAS';
  const gasColLength = Math.max(String(maxGasPerLine).length, gasColTitle.length);
  const header = `┌───┬${ ''.padStart(gasColLength + 2, '─') }┐\n` +
                 `│ C │${ padCenter(gasColTitle, gasColLength + 2, ' ') }│\n` +
                 `├───┼${ ''.padStart(gasColLength + 2, '─') }┤`;
  const footer = `└───┴${ ''.padStart(gasColLength + 2, '─') }┘`;
  const callType = chalk.yellow('+');

  souceFilenames.forEach(fileName => {
    const source = sourceByFilename[fileName];
    if (!source.text || !hasGasByFilename[fileName]) {
      return;
    }

    console.log(`\nFile ${fileName}\n${header}`);

    source.text.split('\n').forEach((lineText, i) => {
      const type = source.linesWithCalls[i] ? callType : ' ';
      const gas = source.lineGas[i] || 0
      const gasText = String(gas).padStart(gasColLength, ' ');
      console.log(`│ ${type} │ ${gas ? chalk.yellow(gasText) : gasText} │ ${lineText}`);
    });

    console.log(footer);
  });

  if (hasCalls) {
    console.log(`\nLines marked with a ${callType} contain calls to other contracts, and gas`);
    console.log(`usage of such lines includes the gas spent by the called code.`);
  }

  return true;
}

function getSourceInfo(call, log) {
  const {contract} = call;
  const pcToIdx = call.isConstructionCall ? contract.constructionPcToIdx : contract.pcToIdx;
  const sourceMap = call.isConstructionCall ? contract.constructorSourceMap : contract.sourceMap;

  if (!pcToIdx || !sourceMap) {
    return {sourceId: null, isSynthOp: false, offset: null, length: null};
  }

  const instructionIdx = pcToIdx[log.pc];
  const {s: offset, f: sourceId, l: length} = sourceMap[instructionIdx];

  // > In the case of instructions that are not associated with any particular source file,
  // > the source mapping assigns an integer identifier of -1. This may happen for bytecode
  // > sections stemming from compiler-generated inline assembly statements.
  // From: https://solidity.readthedocs.io/en/v0.6.7/internals/source_mappings.html
  return sourceId === -1
    ? {sourceId: null, isSynthOp: true, offset, length}
    : {sourceId, isSynthOp: false, offset, length};
}

function getGasCost(log, nextLog) {
  const {op} = log
  // Ganache reports negative gasCost for return ops to account for compensation of 1/64 gas
  // that was held when making a call; see Appendix H of Ethereum yellow paper and
  // https://medium.com/@researchandinnovation/the-dark-side-of-ethereum-1-64th-call-gas-reduction-967d12e0627e
  if (log.gasCost < 0 && (op === 'RETURN' || op === 'REVERT' || op === 'STOP')) {
    return 0;
  }
  if (nextLog && nextLog.depth === log.depth && (op === 'CALL' || op === 'CALLCODE' || op === 'DELEGATECALL' || op === 'STATICCALL')) {
    // geth reports the cost including 1/64 gas deposit even if it doesn't intorduce
    // a new stack item (e.g. calls to precompiled contracts like sha256), so the
    // deposit is already returned by the next opcode
    return log.gas - nextLog.gas;
  }
  return log.gasCost;
}

function getCallTarget(log, iLog, structLogs) {
  switch (log.op) {
    case 'CALL': // https://ethervm.io/#F1
    case 'CALLCODE': // https://ethervm.io/#F2
    case 'DELEGATECALL': // https://ethervm.io/#F4
    case 'STATICCALL': { // https://ethervm.io/#FA
      return {
        addressHexStr: normalizeAddress(log.stack[log.stack.length - 2]),
        isConstructionCall: false
      };
    }
    case 'CREATE': // https://ethervm.io/#F0
    case 'CREATE2': { // https://ethervm.io/#F5
      let nextLogSameDepth = null;
      for (++iLog; iLog < structLogs.length && !nextLogSameDepth; ++iLog) {
        const nextLog = structLogs[iLog];
        if (nextLog.depth === log.depth) {
          nextLogSameDepth = nextLog;
        }
      }
      return {
        addressHexStr: nextLogSameDepth
          ? normalizeAddress(nextLogSameDepth.stack[nextLogSameDepth.stack.length - 1])
          : null,
        isConstructionCall: true
      };
    }
    default: {
      return {
        addressHexStr: null,
        isConstructionCall: false
      };
    }
  }
}

function increaseLineGasCost(source, line, gasCost, isCall) {
  if (source != null && line != null && !source.skip) {
    source.lineGas[line] = (source.lineGas[line] | 0) + gasCost;
    if (isCall) {
      source.linesWithCalls[line] = true;
    }
  }
}

async function getContractWithAddr(addr, web3, solcOutput, isDump, codeByAddr) {
  const addressHexStr = normalizeAddress(addr);

  const cached = contractByAddr[addressHexStr];
  if (cached) {
    return cached;
  }

  const result = makeContract(addressHexStr);
  contractByAddr[addressHexStr] = result;

  const code = isDump
    ? codeByAddr[addressHexStr]
    : await web3.eth.getCode(addressHexStr);

  result.codeHexStr = strip0x(code) || null;
  if (!result.codeHexStr) {
    console.error(`WARN no code at address 0x${addressHexStr}`);
    return result;
  }

  if (!isDump && codeByAddr) {
    codeByAddr[addressHexStr] = code;
  }

  result.pcToIdx = buildPcToInstructionMapping(result.codeHexStr);

  const contractData = findContractByDeployedBytecode(result.codeHexStr, solcOutput);
  if (!contractData) {
    console.error(`WARN no source for contract at address 0x${addressHexStr}`);
    return result;
  }

  result.constructionСodeHexStr = contractData.constructionСodeHexStr;
  result.constructionPcToIdx = buildPcToInstructionMapping(result.constructionСodeHexStr);

  result.name = contractData.name;
  result.fileName = contractData.fileName;
  result.sourceMap = parseSourceMap(contractData.sourceMap);
  result.constructorSourceMap = parseSourceMap(contractData.constructorSourceMap);

  return result;
}

function findContractByDeployedBytecode(codeHexStr, solcOutput) {
  const filesNames = Object.keys(solcOutput.contracts);
  for (let iFile = 0; iFile < filesNames.length; ++iFile) {
    const fileName = filesNames[iFile];
    const fileContracts = solcOutput.contracts[fileName];
    const contractNames = Object.keys(fileContracts);
    for (let iContract = 0; iContract < contractNames.length; ++iContract) {
      const name = contractNames[iContract];
      const contractData = fileContracts[name];
      if (contractData.evm.deployedBytecode.object === codeHexStr) {
        return {
          fileName,
          name,
          sourceMap: contractData.evm.deployedBytecode.sourceMap,
          constructorSourceMap: contractData.evm.bytecode.sourceMap,
          constructionСodeHexStr: contractData.evm.bytecode.object
        };
      }
    }
  }
  return null;
}

async function getSourceWithId(sourceId, sourceProvider) {
  const cached = sourceById[sourceId];
  if (cached) {
    return cached;
  }

  const fileName = sourceProvider.getSourceFilename(sourceId);
  const result = makeSource(sourceId, fileName);
  sourceById[sourceId] = result;

  if (!fileName) {
    console.error(`WARN no source with id ${sourceId}`);
    return result;
  }

  sourceByFilename[fileName] = result;
  result.skip = sourceProvider.skipFiles.some(str => fileName.indexOf(str) !== -1);

  if (!result.skip) {
    result.text = await sourceProvider.readSource(fileName, sourceId);
  }

  if (result.text) {
    result.lineOffsets = buildLineOffsets(result.text);
  } else if (!result.skip) {
    console.error(`WARN no source text for filename ${fileName} (id ${result.id})`);
  }

  return result;
}

function makeGetSourceFilenameFromSolcOutputJson(solcOutput) {
  return function getSourceFilenameSolcOutputJson(sourceId) {
    return Object
      .keys(solcOutput.sources)
      .find(fileName => solcOutput.sources[fileName].id === sourceId) || null;
  }
}

function makeReadSourceFromDisk(sourceRoot) {
  return async function readSourceFromDisk(fileName, sourceId) {
    try {
      const sourcePath = path.resolve(sourceRoot, fileName);
      return await readFile(sourcePath);
    } catch (err) {
      try {
        const sourcePath = require.resolve(fileName);
        return await readFile(sourcePath);
      } catch (err) {
        return null;
      }
    }
  }
}

function makeReadSourceFromSolcInputJSON(solcInput) {
  return function readSourceFromSolcInputJSON(fileName, sourceId) {
    const source = solcInput.sources[fileName];
    return source && source.content || null;
  }
}

function readFile(path) {
  return new Promise((resolve, reject) => {
    fs.readFile(path, 'utf8', (err, data) => err ? reject(err) : resolve(data));
  })
}

function buildLineOffsets (src) {
  let accu = 0;
  return src.split('\n').map(line => {
    const ret = accu;
    accu += line.length + 1;
    return ret;
  });
}

function buildPcToInstructionMapping (codeHexStr) {
  const mapping = {};
  let instructionIndex = 0;
  for (let pc=0; pc<codeHexStr.length/2;) {
    mapping[pc] = instructionIndex;

    const byteHex = codeHexStr[pc*2]+codeHexStr[pc*2+1];
    const byte = parseInt(byteHex, 16);

    // PUSH instruction has immediates
    if (byte >= 0x60 && byte <= 0x7f) {
        const n = byte-0x60+1; // number of immediates
        pc += (n+1);
    } else {
        pc += 1;
    }

    instructionIndex += 1;
  }
  return mapping;
}

// https://solidity.readthedocs.io/en/develop/miscellaneous.html#source-mappings
function parseSourceMap (raw) {
  let prevS, prevL, prevF, prevJ;
  return raw.trim().split(';').map(section=> {
    let [s,l,f,j] = section.split(':');

    if (s==='' || s===undefined) {
      s = prevS;
    } else {
      prevS = s;
    }

    if (l==='' || l===undefined) {
      l = prevL;
    } else {
      prevL = l;
    }

    if (f==='' || f===undefined) {
      f = prevF;
    } else {
      prevF = f;
    }

    if (j==='' || j===undefined) {
      j = prevJ;
    } else {
      prevJ = j;
    }

    return {s:Number(s), l:Number(l), f:Number(f), j};
  });
}

function isValidTransactionId(str) {
  return /^0x[0123456789abcdefABCDEF]{64}$/.test(str);
}

function tryReadJSONFile(fileName) {
  let data;
  try {
    data = fs.readFileSync(fileName, 'utf8');
  } catch (err) {
    return null;
  }
  return JSON.parse(data);
}

function getWeb3(rpcEndpoint) {
  const provider = new Web3.providers.HttpProvider(rpcEndpoint);
  const web3 = new Web3(provider);
  web3.extend({
    methods: [
      { name: 'traceTx', call: 'debug_traceTransaction', params: 2 },
      { name: 'getClientVersion', call: 'web3_clientVersion', params: 0 }
    ]
  });
  return web3;
}

function normalizeAddress(addressHexStr) {
  if (!addressHexStr) {
    return addressHexStr;
  }
  const addressBN = new BN(strip0x(addressHexStr), 16);
  return addressBN.toString(16, 40);
}

function strip0x(hexStr) {
  return hexStr && hexStr[0] === '0' && hexStr[1] === 'x'
    ? hexStr.substring(2)
    : hexStr
}

function padCenter(str, targetLength, padSymbol = ' ') {
  const totalPad = targetLength - str.length;
  if (totalPad <= 0) {
    return str;
  }
  const leftPad = Math.floor(totalPad / 2);
  return str.padStart(str.length + leftPad, padSymbol).padEnd(targetLength, padSymbol);
}
