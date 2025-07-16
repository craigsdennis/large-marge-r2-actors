import { Actor, type ActorState } from '@cloudflare/actors';

type PartRequest = {
	partNumber: number;
	partStart: number;
	partEnd: number;
};

type Configuration = {
	original_file_name: string;
	file_size: number;
	key: string;
	multipart_upload_id: string;
};

type Part = {
	part_number: number;
	part_start: number;
	part_end: number;
	r2_uploaded_part: string;
	completed: boolean;
};

const PART_SIZE = 10 * 1024 * 1024; // 10mb

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
                original_file_name TEXT NOT NULL,
				file_size INTEGER NOT NULL,
				key TEXT NOT NULL,
				multipart_upload_id TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

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
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
			},
		];
		ctx?.blockConcurrencyWhile(async () => {
			await this.storage.runMigrations();
		});
	}

	async initialize(originalFileName: string, fileSize: number) {
		// TODO: Find a unique name for the key
		const key = originalFileName;
		// Create the multi-partupload
		this._multiPartUpload = await this.env.BIGGIES.createMultipartUpload(key);
		this.sql`DELETE FROM configuration;`;
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
			let partEnd = partStart + PART_SIZE;
			if (i === partCount - 1) {
				const remainder = fileSize % PART_SIZE;
				partEnd = partStart + remainder;
			}
			this.sql`INSERT INTO parts (part_number, part_start, part_end) VALUES (${i + 1}, ${partStart}, ${partEnd});`;
		}
	}

	async getMultiPartUpload() {
		// Use cache first
		if (this._multiPartUpload) {
			return this._multiPartUpload;
		}
		const config = await this.getConfiguration();
		if (config === undefined) {
			throw new Error('Configuration is missing, call initialize first');
		}
		this._multiPartUpload = this.env.BIGGIES.resumeMultipartUpload(config.key, config.multipart_upload_id);
		return this._multiPartUpload;
	}

	async getMissingPartRequests(): Promise<PartRequest[]> {
		const missing = this.sql<Part>`SELECT * FROM parts WHERE completed = 'f' ORDER BY part_number;`;
		const partRequests = missing.map((row) => {
			return {
				partNumber: row.part_number as number,
				partStart: row.part_start as number,
				partEnd: row.part_end as number,
			};
		});
		return partRequests;
	}

	async getConfiguration(): Promise<Configuration> {
		// Load the configuration
		const results = this.sql<Configuration>`SELECT * FROM configuration ORDER BY created_at DESC LIMIT 1`;
		return results[0];
	}

	// Use fetch so we can use the request
	async fetch(request: Request): Promise<Response> {
		if (request.method === 'PATCH') {
			const url = new URL(request.url);
			const [_, apiCheck, uploadsCheck, uploaderId, partNumberString] = url.pathname.split('/');
			if (apiCheck === 'api' && uploadsCheck === 'uploads' && this.identifier === uploaderId) {
				const partNumber = parseInt(partNumberString);
				const mpu = await this.getMultiPartUpload();
				// R2 Upload
				const part = await mpu.uploadPart(partNumber, request.body as ReadableStream);
				// Update the db
				this.sql`UPDATE parts SET
					r2_uploaded_part=${JSON.stringify(part)},
					completed='t',
					updated_at=CURRENT_TIMESTAMP
				WHERE
					part_number=${partNumber}`;
				const results = this.sql<{ remaining: number }>`SELECT count(*) as remaining FROM parts WHERE completed='f'`;
				const remainingCount = results[0].remaining;
				if (remainingCount === 0) {
					const partsResults = this.sql<{ r2_uploaded_part: string }>`SELECT r2_uploaded_part FROM parts ORDER BY part_number`;
					const parts = partsResults.map((row) => JSON.parse(row.r2_uploaded_part));
					await mpu.complete(parts);
				}
				return Response.json({ success: true, remainingCount });
			}
		}
		return new Response('Not Found', { status: 404 });
	}
}
