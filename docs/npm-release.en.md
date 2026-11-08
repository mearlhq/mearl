# npm publishing

[简体中文](npm-release.md) | [English](npm-release.en.md)

`.github/workflows/publish.yml` uses GitHub-hosted Ubuntu, Node 24, and npm OIDC. No `NPM_TOKEN` is required; pnpm still checks the clean worktree, publish branch, and remote synchronization. Publishing runs only after all checks pass, with all packages at one version. The `beta` channel accepts only `x.y.z-beta.n` and publishes to the `beta` tag; `stable` accepts only `x.y.z` and uses `latest`. Both share the same npm trust connection. Each package's trusted publisher must use repository `mearlhq/mearl` and workflow `publish.yml`.

## Initial configuration

Each public npm package must trust the same workflow:

```sh
npm trust github @mearl/<package> --repository mearlhq/mearl --file publish.yml --allow-publish --yes
```

This step requires npm account sign-in and two-factor verification; configuration is also available in npm package settings. Use only `publish.yml` as the workflow filename, without a directory. Package `repository.url` must match the GitHub repository. Private GitHub repositories can use trusted publishing, but npm does not generate public provenance for them.

## Start and retry

In Actions, choose **Publish → Run workflow**, the source branch, and `beta` or `stable` (default: `beta`). The workflow queries official npm to select the beta version automatically without input or source changes. Stable runs must be manually triggered from main with committed stable versions and release notes.

After merging release source into `main`, start the beta from `main`. Normal pushes and PRs do not publish npm; release-workflow changes trigger complete artifact validation. After fixing npm trust, use **Re-run failed jobs** to retry the publish job with the successful build's saved artifact. Do not rerun the entire workflow to repackage. Version records must match original artifact digests; published bytes cannot be replaced.

The workflow verifies checkout matches the event commit and publishes only after the full build, type checking, boundary and browser resource checks, and full tests pass. See the [release guide](releases.en.md) and workflow for version caching, retries, and branch rules. Stable versions require the version maintenance process, review, validation, and an explicit stable release request.

Official references: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/), [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
