import * as core from '@actions/core';
import {getExecOutput} from '@actions/exec';
import * as tools from '@actions/tool-cache';
import * as path from 'path';
import {Octokit} from '@octokit/rest';
import {clean as semver_clean, compare as semver_compare} from 'semver';
import * as os from 'os';
import * as fs from "fs";

class RequestedVersion {
    private static isStable(version: string): boolean {
        return version === 'stable';
    }

    private static isLatest(version: string): boolean {
        return version === 'latest';
    }

    readonly semverVersion: string | null;
    constructor(public inputVersion: string) {
        if (RequestedVersion.isStable(inputVersion) || RequestedVersion.isLatest(inputVersion)) {
            this.semverVersion = null;
            return;
        }
        const v = semver_clean(this.inputVersion);
        if (!v) throw new Error(`Invalid version: ${this.inputVersion}`);
        this.semverVersion = v;
    }

    get isStable(): boolean {
        return RequestedVersion.isStable(this.inputVersion);
    }

    get isLatest(): boolean {
        return RequestedVersion.isLatest(this.inputVersion);
    }

    get tagName(): string {
        if (this.isStable || this.isLatest || !this.semverVersion) {
            throw new Error(`Cannot get tag name for ${this.inputVersion}`);
        }
        return `v${this.semverVersion}`;
    }
}

interface IInstalledVersion {
    version: string;
    path: string;
}

interface IReleaseAsset {
    name: string;
    url: string;
    browser_download_url: string;
}

interface IRelease {
    tag_name: string;
    assets: IReleaseAsset[];
}

const osPlat= (() => {
    switch (os.platform()) {
        case 'linux': return 'linux';
        case 'darwin': return 'macOS';
        case 'win32': return 'windows';
        default: throw new Error(`Unsupported platform: ${os.platform()}`);
    }
})();
const osArch = (() => {
    const arch = os.arch();
    return (arch === 'x64') ? 'amd64' : arch;
})();
const toolName = 'gh-cli';
const execName = osPlat === 'windows' ? 'gh.exe' : 'gh';
const assetExtension = osPlat === 'windows' ? 'zip' : 'tar.gz';

async function setAndCheckOutput(installedVersion: IInstalledVersion) {
    await core.group('Checking installation', async () => {
        if (core.isDebug()) {
            core.debug(`Installed version: ${installedVersion.version}`);
            core.debug(`Installed path: ${installedVersion.path}`);
            core.debug('Contents of path:');
            core.debug(`${fs.readdirSync(installedVersion.path).join('\n')}`);
        }
        core.addPath(path.join(installedVersion.path, 'bin'));
        const versionOutput = await getExecOutput(execName, ['version']);
        if (versionOutput.stdout.indexOf(installedVersion.version) < 0)
            throw new Error(`gh version ${installedVersion.version} not found in output: ${versionOutput.stdout}`);
        core.setOutput('installed-version', installedVersion.version);
    });
}

async function findMatchingRelease(version: RequestedVersion, token: string | null): Promise<IRelease> {
    let octokit: Octokit;
    if (token) {
        octokit = new Octokit({auth: token});
    } else {
        octokit = new Octokit();
    }

    const baseParams = {
        owner: 'cli',
        repo: 'cli',
    };
    if (version.isStable) {
        const latestRelease = await octokit.rest.repos.getLatestRelease(baseParams);
        return latestRelease.data;
    } else if (version.isLatest) {
        const releasesResp = await octokit.rest.repos.listReleases({
            ...baseParams,
            per_page: 100,
        });
        const releases = releasesResp.data.filter(r => !!semver_clean(r.tag_name));
        if (releases.length <= 0)
            throw new Error('Could not find a valid release!');
        releases.sort((l, r) => semver_compare(semver_clean(r.tag_name)!, semver_clean(l.tag_name)!));
        return releases[0];
    } else {
        const release = await octokit.rest.repos.getReleaseByTag({
            ...baseParams,
            tag: version.tagName,
        });
        return release.data;
    }
}

async function install(asset: IReleaseAsset, version: string): Promise<IInstalledVersion> {
    const downloadedPath = await tools.downloadTool(asset.browser_download_url);
    let extractedPath: string;
    if (assetExtension === 'zip') {
        extractedPath = await tools.extractZip(downloadedPath);
    } else {
        extractedPath = await tools.extractTar(downloadedPath);
        extractedPath = path.join(extractedPath, path.basename(asset.name, `.${assetExtension}`));
    }
    const cachedPath = await tools.cacheDir(extractedPath, execName, toolName, version);
    return {version, path: cachedPath};
}

function checkCache(version: string): IInstalledVersion | null {
    const semverVersion = semver_clean(version);
    if (!semverVersion) throw new Error(`Invalid version: ${version}`);
    const cachedVersion = tools.find(toolName, semverVersion);
    if (cachedVersion) {
        core.info('Found cached version.');
        return {version: semverVersion, path: cachedVersion};
    }
    return null;
}

async function main() {
    core.startGroup('Validate input');
    const version = new RequestedVersion(core.getInput('version', {required: true}));
    const ghToken = core.getInput('github-token');
    core.endGroup();

    let installedVersion = await core.group('Checking cache', async () => {
        if (!version.isStable && !version.isLatest) {
            return checkCache(version.tagName);
        }
        return null;
    });
    if (installedVersion) return await setAndCheckOutput(installedVersion);

    let release: IRelease;
    installedVersion = await core.group('Fetching release', async () => {
        release = await findMatchingRelease(version, ghToken);
        return checkCache(release.tag_name);
    });
    if (installedVersion) return await setAndCheckOutput(installedVersion);

    installedVersion = await core.group('Installing release', async () => {
        const version = semver_clean(release.tag_name);
        if (!version) throw new Error(`Invalid version: ${release.tag_name}`);
        const assetName = `gh_${version}_${osPlat}_${osArch}.${assetExtension}`;
        const asset = release.assets.find(a => a.name === assetName);
        if (!asset) throw new Error(`Could not find a release asset for '${assetName}'`);
        return await install(asset, version);
    });
    await setAndCheckOutput(installedVersion);
}

try {
    main().catch((error) => core.setFailed(error.message));
} catch (error: any) {
    core.setFailed(error.message);
}
