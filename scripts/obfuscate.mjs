import { readFileSync, writeFileSync, unlinkSync, readdirSync, chmodSync } from "fs";
import { join } from "path";
import JavaScriptObfuscator from "javascript-obfuscator";

const DIST_DIR = new URL("../dist/", import.meta.url).pathname;

const obfuscatorConfig = {
  target: "node",
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  renameProperties: false,
  rotateStringArray: true,
  selfDefending: false,
  stringArray: true,
  stringArrayEncoding: ["rc4"],
  stringArrayThreshold: 1,
  splitStrings: true,
  splitStringsChunkLength: 5,
  disableConsoleOutput: false,
  debugProtection: false,
  numbersToExpressions: true,
  simplify: true,
  transformObjectKeys: true,
  log: false,
};

const files = readdirSync(DIST_DIR);

// Delete all .d.ts files
for (const file of files) {
  if (file.endsWith(".d.ts")) {
    unlinkSync(join(DIST_DIR, file));
    console.log(`Deleted ${file}`);
  }
}

// Obfuscate all .js files
for (const file of files) {
  if (!file.endsWith(".js")) continue;

  const filePath = join(DIST_DIR, file);
  let code = readFileSync(filePath, "utf8");

  let shebang = "";
  if (file === "cli.js" && code.startsWith("#!")) {
    const newlineIndex = code.indexOf("\n");
    shebang = code.slice(0, newlineIndex + 1);
    code = code.slice(newlineIndex + 1);
  }

  const result = JavaScriptObfuscator.obfuscate(code, obfuscatorConfig);
  const obfuscated = shebang + result.getObfuscatedCode();

  writeFileSync(filePath, obfuscated);
  console.log(`Obfuscated ${file}`);

  if (file === "cli.js") {
    chmodSync(filePath, 0o755);
  }
}

console.log("Done.");
