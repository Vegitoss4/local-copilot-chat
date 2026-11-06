import * as path from 'path';
import * as Mocha from 'mocha';
import * as fs from 'fs';

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 15000
  });

  const testsRoot = path.resolve(__dirname, '.');

  return new Promise((resolve, reject) => {
    fs.readdir(testsRoot, (err, files) => {
      if (err) {
        return reject(err);
      }

      // Add test files
      files.filter(f => f.endsWith('.test.js')).forEach(f => {
        mocha.addFile(path.resolve(testsRoot, f));
      });

      try {
        mocha.run(failures => {
          if (failures > 0) {
            reject(new Error(`${failures} integration tests failed.`));
          } else {
            resolve();
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}
