module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.ts'],
    verbose: true,
    forceExit: true,
    clearMocks: true,
    resetModules: true,
    restoreMocks: true,
    setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],

    // --- Couverture (npm run test:ci) -------------------------------------------------
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/tests/**',
        '!src/types/**',
        '!src/data/**',
        '!src/i18n/**',
    ],
    coverageReporters: ['text-summary', 'lcov'],
    // Plancher de NON-RÉGRESSION (valeurs mesurées - marge) : la couverture globale ne peut
    // plus baisser, et les chemins critiques (auth, paiements, sécurité HTTP) sont plus
    // exigeants. À relever au fil de l'ajout de tests, jamais à baisser.
    coverageThreshold: {
        global: { statements: 26, branches: 12, functions: 11, lines: 27 },
        './src/utils/safeCompare.ts': { statements: 100, branches: 100, lines: 100 },
        './src/utils/authCookies.ts': { statements: 100, branches: 100, lines: 100 },
        './src/middleware/clientApiKey.ts': { statements: 85, branches: 80, lines: 85 },
        './src/middleware/errorHandler.ts': { statements: 60, branches: 55, lines: 60 },
        './src/services/paymentPollingService.ts': { statements: 90, branches: 75, lines: 90 },
        './src/services/authService.ts': { statements: 45, branches: 40, lines: 48 },
    },
};
