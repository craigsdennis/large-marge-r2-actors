import { Actor, type ActorState } from '@cloudflare/actors';

export type PartRequest = {
	partNumber: number;
	partStart: number;
	partEnd: number;
};

const PART_SIZE = 10 * 1024 * 1024; // 10 Meg

export class Uploader extends Actor<Env> {
	// Cached at the instance level
	_multiPartUpload?: R2MultipartUpload;

	constructor(ctx?: ActorState, env?: Env) {
		super(ctx, env);

		// Set migrations for the SQLite database
		this.storage.migrations = [
			{
				idMonotonicInc: 1,
				description: 'Create configuration table',
				sql: `CREATE TABLE IF NOT EXISTS configuration (
                id INTEGER PRIMARY KEY,
                original_filename TEXT NOT NULL,
				file_size INTEGER NOT NULL,
				key TEXT NOT NULL,
				multipart_upload_id TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW,
            );`,
			},
			{
				idMonotonicInc: 2,
				description: 'Create parts table',
				sql: `CREATE TABLE IF NOT EXISTS parts (
                part_number INTEGER PRIMARY_KEY,
				part_start INTEGER,
				part_end INTEGER,
				r2_uploaded_part STRING,
                completed BOOLEAN DEFAULT 'f',
				created_at TIMESTAMP DEFAULT NOW,
				last_updated TIMESTAMP DEFAULT NOW
            );`,
			},
		];
		ctx?.blockConcurrencyWhile(async () => {
			await this.storage.runMigrations();
		});
	}

	partRequestForPartNumber(partNumber: number, fileSize: number): PartRequest {
		const partStart = partNumber * PART_SIZE;
		let partEnd = (partNumber + 1) * PART_SIZE;
		// If it's the last it will be a little less
		if (partEnd > fileSize) {
			const remainder = fileSize % PART_SIZE;
			partEnd = partStart + remainder;
		}
		return { partNumber, partStart, partEnd };
	}

	async initialize(originalFileName: string, fileSize: number) {
		// TODO: Find a unique name for the key
		const key = originalFileName;
		// Create the multi-partupload
		this._multiPartUpload = await this.env.BIGGIES.createMultipartUpload(key);
		this.sql`DELETE FROM configuration`;
		// Insert into configuration
		this.sql`INSERT INTO configuration (
			original_file_name,
			file_size,
			key,
			multipart_upload_id
		) VALUES (${originalFileName}, ${fileSize}, ${key}, ${this._multiPartUpload.uploadId})`;
		this.sql`DELETE FROM parts;`;
		const partCount = Math.ceil(fileSize / PART_SIZE);
		for (let i = 0; i < partCount; i++) {
			const partStart = i * PART_SIZE;
			// Is there an extra byte, here?
			let partEnd = partStart + PART_SIZE;
			if (i === partCount - 1) {
				const remainder = fileSize % PART_SIZE;
				partEnd = partStart + remainder;
			}
			this.sql`INSERT INTO parts (part_number, part_start, part_end) VALUES (${i}, ${partStart}, ${partEnd});`;
		}
	}

	async getMultiPartUpload() {
		// Use cache first
		if (this._multiPartUpload) {
			return this._multiPartUpload;
		}
		// TODO: Type the config
		const config = await this.getConfiguration();
		if (config === undefined) {
			throw new Error('Configuration is missing, call initialize first');
		}
		this._multiPartUpload = this.env.BIGGIES.resumeMultipartUpload(config.key as string, config.multipart_upload_id as string);
		return this._multiPartUpload;
	}

	async getMissingPartRequests(): Promise<PartRequest[]> {
		const missing = this.sql`SELECT * FROM parts WHERE completed = 'f' ORDER BY part_number`;
		const partRequests = missing.map((index) => this.partRequestForPartNumber(index, config.file_size));
		return partRequests;
	}

	async getConfiguration() {
		// Load the configuration
		const results = this.sql`SELECT * FROM configuration ORDER BY created_at DESC LIMIT 1`;
		return results[0];
	}

	// Use fetch so we can use the request
	async fetch(request: Request): Promise<Response> {
		if (request.method === 'PATCH') {
			const url = new URL(request.url);
			const [apiCheck, uploadsCheck, uploaderId, partNumberString] = url.pathname.split('/');
			if (apiCheck === 'api' && uploadsCheck === 'uploads' && uploaderId === this.identifier) {
				const partNumber = parseInt(partNumberString);
				const mpu = await this.getMultiPartUpload();
				// R2 Upload
				const part = await mpu.uploadPart(partNumber, request.body as ReadableStream);
				// Update the db
				this.sql`UPDATE parts SET
					r2_uploaded_part=${JSON.stringify(part)},
					completed='t',
					updated_at=NOW
				WHERE
					part_number=${partNumber}`;
				return Response.json({ success: true });
			}
		}
		return new Response('Not Found', { status: 404 });
	}
}
