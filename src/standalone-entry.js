import { runCli } from './cli.js';

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
