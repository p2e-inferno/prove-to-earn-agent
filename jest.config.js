/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testTimeout: 15000,
  testPathIgnorePatterns: ["/node_modules/", "/reference/", "/dist/"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
    "^@vendor/(.*)$": "<rootDir>/src/vendor/$1",
    "^@adapters/(.*)$": "<rootDir>/src/adapters/$1",
    "^@p2e/agent-gateway$": "<rootDir>/packages/agent-gateway/src/index.ts",
    "^@p2e/agent-gateway/(.*)$": "<rootDir>/packages/agent-gateway/src/$1",
    "^@p2e/agent-runner$": "<rootDir>/packages/agent-runner/src/index.ts",
    "^@p2e/agent-runner/(.*)$": "<rootDir>/packages/agent-runner/src/$1",
    "^@p2e/agent-contracts$": "<rootDir>/packages/agent-contracts/src/index.ts",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
        },
      },
    ],
  },
};
