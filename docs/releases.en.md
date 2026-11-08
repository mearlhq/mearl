# Releases

[简体中文](releases.md) | [English](releases.en.md)

The main repository is `mearlhq/mearl`; release source is merged into `main`. In GitHub Actions, choose **Publish → Run workflow**, select `main`, and choose the `beta` or `stable` channel.

## Beta

Beta builds are iteration artifacts. The Action queries npm versions for all public packages and selects the highest published beta number plus one for the source target version, starting at beta.0. It exports the selected source commit into an independent build directory, synchronizes npm package versions, the extension Manifest, MCP metadata, and Skill directory versions, then builds, checks, tests, and packages. Version files are not written back to the source branch, and no stable changelog or separate version commit is generated.

Source is identified by commit and prerelease tag; artifacts by the automatically selected beta version. The source-version field in a tag may retain the development version. GitHub prereleases record the corresponding commit and attach the extension ZIP, `config.json`, `toolbox.json`, and license. npm uses the `beta` tag.

Release workflow code changes automatically run validation only: full build, Node 20.18.0 runtime checks, type checks, tests, and packaging, saved as an Actions artifact. npm publishing and GitHub tag/prerelease writes run only on manual invocation.

An Actions cache preserves version records within a workflow run. Build and publish are separate jobs: the build saves an immutable artifact; publishing downloads and validates it. On publish failure, choose **Re-run failed jobs** (`gh run rerun <run-id> --failed`) to retry only publishing with the same version and bytes, without rebuilding. Do not rerun a successful build to replace its artifact. If the artifact is missing or expired, stop, check partial publication state, and start a new run. Build retries also stop if the version cache is missing. New runs requery published versions. If the source target version is already stable, beta advances to the next unpublished patch version.

Publishing uses npm's trusted `publish.yml` OIDC identity. Validated tarballs are published individually from the clean original source directory, preserving pnpm's branch, worktree, and remote checks. Retries first verify integrity digests of existing npm versions: identical artifacts can be skipped, conflicts stop publishing. GitHub tags pin the original commit; existing download attachments must match these artifacts, without overwriting different commits or attachments.

## Stable releases

Manually select `stable` on `main`. First prepare, review, and commit consistent version files, `changelogs/v<version>.md`, and `changelogs/v<version>.en.md`. The workflow reads that stable version and uses the Chinese notes as the GitHub Release body, with a link to the English notes. npm uses `latest`.

After npm publishing and GitHub Release creation, **Submit Chrome Web Store review** submits the same verified extension ZIP. The store publishes it automatically after approval. This job runs only for manual `stable` releases from `main`.

Restrict the `chrome-webstore` GitHub environment to deployments from `main`. Set the publisher ID as the environment variable `CHROME_WEBSTORE_PUBLISHER_ID` and the authorized [Chrome Web Store service account](https://developer.chrome.com/docs/webstore/service-accounts) JSON as the environment secret `CHROME_WEBSTORE_SERVICE_ACCOUNT_JSON`. If submission fails, check the upload and review status in the Developer Dashboard. If the same version is already uploaded as a draft, submit it from the dashboard. Rerunning a failed job uses the original artifact.

Repository visibility determines access to GitHub extension attachments. Development validation can load local `packages/extension/dist_chrome`; release validation uses the extracted matching prerelease ZIP.

## Windows release smoke checks

Manually run `.github/workflows/windows-smoke.yml` through GitHub Actions. It reads npm's current beta and installs official runtime packages and the matching GitHub extension ZIP. A temporary Windows runner uses a separate Chrome for Testing profile to verify Native Messaging registration, matching Chrome/Native Host versions, CLI named-pipe round trips, and registration cleanup, then saves a `windows-runtime-smoke` evidence artifact. It checks published artifacts and does not replace candidate-source CI, full Windows UI validation, or third-party service acceptance.
