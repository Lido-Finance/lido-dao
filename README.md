# DePool DAO smart contracts

## Development

### Requirements 

* NodeJs 12
* (optional) Lerna

### Installing Aragon & other deps

Installation is local and don't require root privileges.

If you have `lerna` installed globally
```bash
npm run bootstrap
```

otherwise

```bash
npx lerna bootstrap 
```


### Build & test all our apps

```bash
npm run test
```

#### Gas meter

In an app folder:

```bash
npm run test:gas
```

#### Generate test coverage report

For all apps, in the repo root:

```bash
npm run test:all:coverage
```

In an app folder:

```bash
npm run test:coverage
```

Test coverage is reported to `coverage.json` and `coverage/index.html` files located
inside each app's folder.

Keep in mind that the code uses `assert`s to check invariants that should always be kept
unless the code is buggy (in contrast to `require` statements which check pre-coditions),
so full branch coverage will never be reported until
[solidity-coverage#219] is implemented.

[solidity-coverage#219]: https://github.com/sc-forks/solidity-coverage/issues/269

### Configuration

Can be specified in a local file `.dev.env`.

For options see [dev.env.default](dev.env.default).

The configuration is read only during new dao deployment.

### Starting & stopping processes

Three process have to be online during development: devchain (ganache), ipfs daemon, front-end:

```bash
./bin/start-dev.sh
```

To stop use:

```bash
./bin/stop-dev.sh
```

### New dao creation

```bash
./bin/deploy-dev-contracts.sh
```

The GUI for the created DAO can be accessed at `http://localhost:3000/?#/<dao_address>/`.

Note: `DAO_ID` must be unique in a blockchain.

### Other

To reset the devchain state, stop the processes and use:

```bash
./node_modules/.bin/aragon devchain --reset

<Ctrl+C>
```
