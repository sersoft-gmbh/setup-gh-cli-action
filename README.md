# Setup GH CLI Action

[![Tests](https://github.com/sersoft-gmbh/setup-gh-cli-action/actions/workflows/tests.yml/badge.svg)](https://github.com/sersoft-gmbh/setup-gh-cli-action/actions/workflows/tests.yml)

A GitHub action that installs or updates the `gh` CLI.

## Inputs

### `version`

The `gh` version to install.<br/>
Can also be set to `latest` to install the latest available version (including prereleases), or `stable` to install the latest stable release.<br/>
Defaults to `stable`.

### `github-token`

The token to use for retrieving the release. Can be set to `${{secrets.GITHUB_TOKEN}}`.<br/>
Use this if you hit rate limits.

## Outputs

### `full-version`

The full version was installed.


## Example Usage

```yaml
uses: sersoft-gmbh/setup-gh-cli-action@v3
with:
  version: stable
```
