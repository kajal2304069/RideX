/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  moduleNameMapper: {
    "^@modules/(.*)$": "<rootDir>/src/modules/$1",
    "^@config/(.*)$": "<rootDir>/src/config/$1",
    "^@middleware/(.*)$": "<rootDir>/src/middleware/$1",
    "^@common/(.*)$": "<rootDir>/src/common/$1",
    "^@db/(.*)$": "<rootDir>/src/db/$1",
    "^@utils/(.*)$": "<rootDir>/src/utils/$1",
  },
  setupFiles: ["<rootDir>/tests/setupEnv.ts"],
  setupFilesAfterEnv: ["<rootDir>/tests/setupAfterEnv.ts"],
  clearMocks: true,
  testTimeout: 15000,
};
