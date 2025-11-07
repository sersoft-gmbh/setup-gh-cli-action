import * as core from '@actions/core';
import {getExecOutput} from '@actions/exec';
import * as tools from '@actions/tool-cache';
import * as path from 'path';
import {Octokit} from '@octokit/rest';
import {clean as semver_clean, compare as semver_compare} from 'semver';
import * as os from 'os';
import * as fs from 'fs';

interface ICleanedVersion {
    readonly versionString: string;
}

const osPlat = (() => {
    switch (os.platform()) {
        case 'linux':
            return 'linux';
        case 'darwin':
            return 'macOS';
        case 'win32':
            return 'windows';
        default:
            throw new Error(`Unsupported platform: ${os.platform()}`);
    }
})();
const osArch = (() => {
    const arch = os.arch();
    return arch === 'x64' ? 'amd64' : arch;
})();
const toolName = 'gh-cli';
const execName = osPlat === 'windows' ? 'gh.exe' : 'gh';

function cleanedVersion(version: string): ICleanedVersion {
    const semverVersion = semver_clean(version);
    if (!semverVersion) throw new Error(`Invalid version: ${version}`);
    return {versionString: semverVersion};
}

function assetExtension(version: ICleanedVersion): string {
    if (osPlat === 'windows') return 'zip';
    if (osPlat !== 'macOS') return 'tar.gz';
    // The macOS assets were changed to zips in 2.28.0.
    return semver_compare(version.versionString, '2.28.0') === -1 ? 'tar.gz' : 'zip';
}

class RequestedVersion {
    private static isStable(version: string): boolean {
        return version === 'stable';
    }

    private static isLatest(version: string): boolean {
        return version === 'latest';
    }

    readonly semverVersion: ICleanedVersion | null;

    constructor(public inputVersion: string) {
        if (RequestedVersion.isStable(inputVersion) || RequestedVersion.isLatest(inputVersion)) {
            this.semverVersion = null;
            return;
        }
        this.semverVersion = cleanedVersion(this.inputVersion);
    }

    get isStable(): boolean {
        return RequestedVersion.isStable(this.inputVersion);
    }

    get isLatest(): boolean {
        return RequestedVersion.isLatest(this.inputVersion);
    }

    get cleanedVersion(): ICleanedVersion {
        if (this.isStable || this.isLatest || !this.semverVersion) {
            throw new Error(`'${this.inputVersion}' is not a valid semver version!`);
        }
        return this.semverVersion;
    }

    get tagName(): string {
        return `v${this.cleanedVersion.versionString}`;
    }
}

interface IInstalledVersion {
    readonly version: ICleanedVersion;
    readonly path: string;
}

interface IReleaseAsset {
    readonly name: string;
    readonly url: string;
    readonly browser_download_url: string;
}

interface IRelease {
    readonly version: ICleanedVersion;
    readonly assets: readonly IReleaseAsset[];
}

async function setAndCheckOutput(installedVersion: IInstalledVersion) {
    await core.group('Checking installation', async () => {
        if (core.isDebug()) {
            core.debug(`Installed version: ${installedVersion.version.versionString}`);
            core.debug(`Installed path: ${installedVersion.path}`);
            core.debug('Contents of path:');
            core.debug(`${fs.readdirSync(installedVersion.path).join('\n')}`);
        }
        core.addPath(path.join(installedVersion.path, 'bin'));
        const versionOutput = await getExecOutput(execName, ['version']);
        if (versionOutput.stdout.indexOf(installedVersion.version.versionString) < 0)
            throw new Error(`gh version ${installedVersion.version.versionString} not found in output: ${versionOutput.stdout}`);
        core.setOutput('installed-version', installedVersion.version.versionString);
    });
}

async function findMatchingRelease(version: RequestedVersion, token: string | null): Promise<IRelease> {
    const octokit: Octokit = token ? new Octokit({auth: token}) : new Octokit();

    const baseParams = {
        owner: 'cli',
        repo: 'cli',
    };
    if (version.isStable) {
        const latestRelease = await octokit.rest.repos.getLatestRelease(baseParams);
        return {
            version: cleanedVersion(latestRelease.data.tag_name),
            assets: latestRelease.data.assets,
        };
    } else if (version.isLatest) {
        const releasesResp = await octokit.rest.repos.listReleases({
            ...baseParams,
            per_page: 100,
        });
        let releases: IRelease[] = [];
        releasesResp.data.forEach(r => {
            try {
                releases.push({
                    version: cleanedVersion(r.tag_name),
                    assets: r.assets,
                });
            } catch (e) {
            }
        });
        if (releases.length <= 0) throw new Error('Could not find a valid release!');
        releases.sort((l, r) => semver_compare(r.version.versionString, l.version.versionString));
        return releases[0];
    } else {
        const release = await octokit.rest.repos.getReleaseByTag({
            ...baseParams,
            tag: version.tagName,
        });
        return {
            version: cleanedVersion(release.data.tag_name),
            assets: release.data.assets,
        };
    }
}

async function install(asset: IReleaseAsset, version: ICleanedVersion): Promise<IInstalledVersion> {
    const downloadedPath = await tools.downloadTool(asset.browser_download_url);
    const extension = assetExtension(version);
    let extractedPath: string;
    switch (extension) {
        case 'zip':
            extractedPath = await tools.extractZip(downloadedPath);
            break;
        case 'tar.gz':
            extractedPath = await tools.extractTar(downloadedPath);
            break;
        default:
            throw new Error(`Unsupported extension: ${extension}`);
    }
    const assetNameWithoutExtension = path.basename(asset.name, `.${extension}`);
    let contents = fs.readdirSync(extractedPath);
    if (!contents.includes('bin') && contents.includes(assetNameWithoutExtension)) {
        extractedPath = path.join(extractedPath, assetNameWithoutExtension);
        contents = fs.readdirSync(extractedPath);
    }
    if (!contents.includes('bin')) {
        core.debug(`Contents:\n${contents.join('\n')}`);
        throw new Error('Could not find a suitable binary folder in the extracted asset!');
    }
    const cachedPath = await tools.cacheDir(extractedPath, execName, toolName, version.versionString);
    return {version, path: cachedPath};
}

function checkCache(version: ICleanedVersion): IInstalledVersion | null {
    const cachedVersion = tools.find(toolName, version.versionString);
    if (!cachedVersion) return null;
    core.info('Found cached version.');
    return {version: version, path: cachedVersion};
}

async function main() {
    core.startGroup('Validate input');
    const version = new RequestedVersion(core.getInput('version', {required: true}));
    const ghToken = core.getInput('github-token') || null;
    core.endGroup();

    let installedVersion = await core.group('Checking cache', async () => {
        return !version.isStable && !version.isLatest ? checkCache(version.cleanedVersion) : null;
    });
    if (installedVersion) return await setAndCheckOutput(installedVersion);

    let release: IRelease;
    installedVersion = await core.group('Fetching release', async () => {
        release = await findMatchingRelease(version, ghToken);
        return checkCache(release.version);
    });
    if (installedVersion) return await setAndCheckOutput(installedVersion);

    installedVersion = await core.group('Installing release', async () => {
        const assetName = `gh_${release.version.versionString}_${osPlat}_${osArch}.${assetExtension(release.version)}`;
        const asset = release.assets.find(a => a.name === assetName);
        if (!asset) throw new Error(`Could not find a release asset for '${assetName}'`);
        return await install(asset, release.version);
    });
    await setAndCheckOutput(installedVersion);
}

try {
    main().catch((error) => core.setFailed(error.message));
} catch (error: any) {
    core.setFailed(error.message);
}
