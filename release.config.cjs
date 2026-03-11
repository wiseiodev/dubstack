module.exports = {
  branches: ['main'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release placeholder syntax
  tagFormat: 'v${version}',
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/npm',
      {
        pkgRoot: 'packages/cli',
      },
    ],
    '@semantic-release/github',
    [
      '@semantic-release/exec',
      {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release placeholder syntax
        successCmd: 'echo ${nextRelease.version} > .semantic-release-version',
      },
    ],
  ],
};
