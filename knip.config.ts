const knipConfig = {
  $schema: 'https://unpkg.com/knip@latest/schema.json',
  ignore: [
    // Test files - testing utilities may not be fully utilized
    '__tests__/**',
  ],
  ignoreDependencies: [],
  ignoreBinaries: [],
  rules: {
    files: 'error',
    dependencies: 'error',
    devDependencies: 'warn',
    unlisted: 'error',
    binaries: 'error',
    unresolved: 'error',
    exports: 'error',
    types: 'error',
    nsExports: 'error',
    nsTypes: 'error',
    duplicates: 'error',
    enumMembers: 'error',
    classMembers: 'error',
  },
};

export default knipConfig;
