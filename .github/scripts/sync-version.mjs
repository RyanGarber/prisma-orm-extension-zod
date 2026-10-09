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
  const oldVersion = packageJson.peerDependencies?.["@prisma/orm-postgres"];
  
  packageJson.peerDependencies ??= {};
  packageJson.peerDependencies["@prisma/orm-postgres"] = postgresVersion;
  const indent = /^\t/m.test(source) ? "\t" : "  ";
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, indent)}\n`);
  console.log(`Updated package.json to use @prisma/orm-postgres@${postgresVersion}.`);
  
  if (oldVersion) {
    const readmePath = new URL("../../README.md", import.meta.url);
    const readme = readFileSync(readmePath, "utf8");
    const newReadme = readme.replaceAll(
      oldVersion,
      postgresVersion,
    );
    writeFileSync(readmePath, newReadme);
    console.log(`Updated README.md to use @prisma/orm-postgres@${postgresVersion}.`);
  }
}
else {
  console.log(`Versions already in sync: ${postgresVersion}.`);
}
