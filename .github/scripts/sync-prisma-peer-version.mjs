import { readFileSync, writeFileSync } from "node:fs";

const packageJsonPath = new URL("../../package.json", import.meta.url);
const source = readFileSync(packageJsonPath, "utf8");
const packageJson = JSON.parse(source);
const postgresVersion = packageJson.devDependencies?.["@prisma/orm-postgres"];
const toolchainVersion = packageJson.devDependencies?.["@prisma/orm-toolchain"];

if (!postgresVersion || !toolchainVersion) {
  throw new Error("Expected both Prisma packages in devDependencies.");
}

if (postgresVersion !== toolchainVersion) {
  throw new Error(
    `Prisma package versions do not match: orm-postgres ${postgresVersion}, orm-toolchain ${toolchainVersion}. Refusing to update the peer dependency.`,
  );
}

if (packageJson.peerDependencies?.["@prisma/orm-postgres"] !== postgresVersion) {
  packageJson.peerDependencies ??= {};
  packageJson.peerDependencies["@prisma/orm-postgres"] = postgresVersion;
  const indent = /^\t/m.test(source) ? "\t" : "  ";
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, indent)}\n`);
}
