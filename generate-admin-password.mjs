import {
  randomBytes,
  scryptSync,
} from 'node:crypto';
import readline from 'node:readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function readPassword(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let password = '';

    const onData = (char) => {
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(password);
        return;
      }

      if (char === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      }

      if (char === '\u007f') {
        password = password.slice(0, -1);
        return;
      }

      password += char;
    };

    process.stdin.on('data', onData);
  });
}

const password = await readPassword('Admin password: ');
const confirmation = await readPassword('Repeat password: ');

rl.close();

if (!password) {
  throw new Error('Password must not be empty');
}

if (password !== confirmation) {
  throw new Error('Passwords do not match');
}

const N = 16384;
const r = 8;
const p = 1;
const keyLength = 64;

const salt = randomBytes(16);

const hash = scryptSync(password, salt, keyLength, {
  N,
  r,
  p,
  maxmem: 64 * 1024 * 1024,
});

const encoded = [
  'scrypt',
  'v1',
  N,
  r,
  p,
  salt.toString('base64url'),
  hash.toString('base64url'),
].join(':');

console.log('\nCopy this to Coolify:\n');
console.log(`COMMERCE_ADMIN_PASSWORD_SCRYPT=${encoded}`);
