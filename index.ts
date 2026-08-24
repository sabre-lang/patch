/// Node Modules
import * as path from 'node:path';
import * as stream from 'node:stream/promises';

/// Vendor Modules
import * as fse from 'fs-extra';
import * as listr from 'listr2';
import * as unzipper from 'unzipper';
import * as archiver from 'archiver';
import { Octokit } from '@octokit/rest';

//  TYPEDEFS  //

/** Task Wrapper Typing. */
type Task = listr.ListrTaskWrapper<any, any, any>;

/** Asset Typing. */
interface Asset {
    readonly id: number;
    readonly name: string;
}

/** Patch Typing. */
interface Patch {
    readonly src: string;
    readonly dst: string;
}

/** Release Typing. */
interface Release {
    readonly id: number;
    readonly assets: Asset[];
    readonly tag_name: string;
}

/** Worker Context. */
class Worker {
    //  PROPERTIES  //

    readonly dirname: string;
    readonly zipfile: string;
    readonly extracted: string;

    //  CONSTRUCTORS  //

    /** Constructs a worker instance. */
    constructor(
        readonly task: Task,
        readonly asset: Asset,
        readonly parent: Release
    ) {
        this.dirname = path.resolve(__dirname, 'assets', this.parent.tag_name);
        this.zipfile = path.join(this.dirname, this.asset.name);
        this.extracted = path.join(this.dirname, path.parse(this.asset.name).name);
    }
}

/** Prepares a session instance. */
class Session {
    //  PROPERTIES  //

    readonly m_owner = 'rroessler';
    readonly m_repo = 'langs.talos';
    readonly m_auth = process.env.GITHUB_ACCESS_TOKEN;
    readonly m_instance = new Octokit({ auth: this.m_auth });
    readonly m_listr = new listr.Listr<any>([], { concurrent: true });

    //  GETTERS x SETTERS  //

    /** Gets the available owner. */
    get owner() {
        return this.m_owner;
    }

    /** Gets the available repository. */
    get repo() {
        return this.m_repo;
    }

    //  PUBLIC METHODS  //

    /** Handles launching the session */
    async launch() {
        // get the available releases
        const releases = await this.m_instance.repos.listReleases({
            repo: this.m_repo,
            owner: this.m_owner
        });

        // pre-clean our outputs directory
        await fse.rm(path.resolve(__dirname, 'assets'), { recursive: true, force: true });

        // and attempt converting them into individual tasks
        await new listr.Listr(
            releases.data.map((release) => ({
                title: `Release: ${release.tag_name}`,
                task: (_, task) => this.m_dispatch(task, release)
            }))
        ).run();
    }

    //  PRIVATE METHODS  //

    /**
     * Handle downloading release assets.
     * @param worker                Worker context.
     */
    private async m_download(worker: Worker) {
        // declare that we are downloading the asset
        worker.task.output = `Downloading: ${worker.asset.name}`;

        // ensure the directory exists before emplacing the zip
        await fse.ensureDir(worker.dirname);

        // prepare the basic reposonse for downloading content
        const response = await this.m_instance.repos.getReleaseAsset({
            owner: this.m_owner,
            repo: this.m_repo,
            asset_id: worker.asset.id,
            headers: { accept: 'application/octet-stream' },
            request: { parseSuccessResponseBody: false }
        });

        // download the incoming asset to be revised
        const sink = fse.createWriteStream(worker.zipfile);

        // write the asset to our desired location now (need forced typing)
        await stream.pipeline(response.data as unknown as ReadableStream, sink);
    }

    /**
     * Handles extracting zipped contents to their locations.
     * @param worker                Worker to extract.
     */
    private async m_unpack(worker: Worker) {
        worker.task.output = `Extracting: ${worker.asset.name}`;
        const directory = await unzipper.Open.file(worker.zipfile);
        await directory.extract({ path: worker.extracted });
        await fse.rm(worker.zipfile); // remove the zip-file

        // don't forget to chmod the executable we have
        const extname = worker.asset.name.includes('windows') ? '.exe' : '';
        await fse.chmod(path.join(worker.extracted, 'bin', `talos${extname}`), 0o755);
    }

    /**
     * Handle replacing release assets.
     * @param worker                Worker context.
     */
    private async m_patch(worker: Worker) {
        worker.task.output = `Replacing: ${worker.asset.name}`;

        // prepare the baseline directory for the patches to be used
        const dirname = path.resolve(__dirname, 'patches');

        // prepare the required patches to be used
        const fileNames = worker.asset.name.includes('windows') ? ['install.ps1'] : ['install.sh'];
        const patches: Patch[] = fileNames.map((fileName) => ({
            src: path.join(dirname, fileName),
            dst: path.join(worker.extracted, 'scripts', fileName)
        }));

        // update all the files to be patched now
        await Promise.all(patches.map((patch) => fse.copyFile(patch.src, patch.dst)));
    }

    /**
     * Handle archiving release assets.
     * @param worker                Worker context.
     */
    private async m_archive(worker: Worker) {
        return new Promise((resolve, reject) => {
            worker.task.output = `Archiving: ${worker.asset.name}`;

            // ensure we are able to pipe our archive instance
            const output = fse.createWriteStream(worker.zipfile);
            const archive = new archiver.ZipArchive({ zlib: { level: 9 } });

            // prepare the required event handlers
            output.on('error', reject);
            output.on('close', resolve);
            archive.on('error', reject);

            archive.pipe(output);
            archive.directory(worker.extracted, false);
            archive.finalize();
        });
    }

    /**
     * Handle uploading release assets.
     * @param worker                Worker context.
     */
    private async m_upload(worker: Worker) {
        worker.task.output = `Uploading: ${worker.asset.name}`;

        // prepare the necessary streaming details
        const stats = await fse.stat(worker.zipfile);
        const stream = fse.createReadStream(worker.zipfile);

        // delete the original release asset
        await this.m_instance.repos.deleteReleaseAsset({
            owner: this.m_owner,
            repo: this.m_repo,
            asset_id: worker.asset.id
        });

        // upload the required archive (clobbering as needed)
        await this.m_instance.repos.uploadReleaseAsset({
            owner: this.m_owner,
            repo: this.m_repo,
            data: stream as any,
            name: worker.asset.name,
            release_id: worker.parent.id,
            headers: {
                'Content-Type': 'application/zip',
                'Content-Length': stats.size
            }
        });
    }

    /**
     * Handle replacing release assets.
     * @param worker                Worker context.
     */
    private async m_worker(worker: Worker) {
        await this.m_download(worker); // download asset
        await this.m_unpack(worker); // extract contents
        await this.m_patch(worker); // replace items
        await this.m_archive(worker); // archive contents
        await this.m_upload(worker); // upload result
    }

    /**
     * Handles delegating replacers.
     * @param parent               Release to update.
     */
    private m_dispatch(task: Task, parent: Release) {
        return task.newListr(
            parent.assets.map((asset) => ({
                title: `Asset File: ${asset.name}`,
                task: async (_, task) => this.m_worker(new Worker(task, asset, parent))
            })),
            { concurrent: true }
        );
    }
}

//  TOOL RUNNER  //

(async () => new Session().launch())();
