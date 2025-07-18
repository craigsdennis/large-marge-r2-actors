import { Actor, Persist, type ActorState } from '@cloudflare/actors';

type PartRequest = {
	partNumber: number;
	partStart: number;
	partEnd: number;
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
	@Persist
	originalFileName?: string;

	@Persist
	fileSize?: number;

	@Persist
	key?: string;

	@Persist
	multiPartUploadId?: string;

	// Cached at the instance level on init/setup
	_multiPartUpload?: R2MultipartUpload;

	async onInit() {
		// Set migrations for the SQLite database
		this.storage.migrations = [
			{
				idMonotonicInc: 1,
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

		this.ctx.blockConcurrencyWhile(async () => {
			await this.storage.runMigrations();
		});
		if (this.multiPartUploadId !== undefined && this.key !== undefined) {
			console.log('Hi reinitializing');
			this._multiPartUpload = this.env.BIGGIES.resumeMultipartUpload(this.key, this.multiPartUploadId);
		}
	}

	async setup(originalFileName: string, fileSize: number) {
		this.originalFileName = originalFileName;
		this.fileSize = fileSize;
		// TODO: Find a unique name for the key
		this.key = originalFileName;
		// Create the multi-part-upload
		this._multiPartUpload = await this.env.BIGGIES.createMultipartUpload(this.key);
		// Persist this value
		this.multiPartUploadId = this._multiPartUpload.uploadId;
		// Clean up anything here previously
		this.sql`DELETE FROM parts;`;
		// Determine what is needed
		const partCount = Math.ceil(fileSize / PART_SIZE);
		for (let i = 0; i < partCount; i++) {
			const partStart = i * PART_SIZE;
			let partEnd = partStart + PART_SIZE;
			if (i === partCount - 1) {
				const remainder = fileSize % PART_SIZE;
				partEnd = partStart + remainder;
			}
			// Store the needed future parts
			this.sql`INSERT INTO parts (part_number, part_start, part_end) VALUES (${i + 1}, ${partStart}, ${partEnd});`;
		}
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

	// Use fetch so we can use the incoming request
	async fetch(request: Request): Promise<Response> {
		if (request.method === 'PATCH') {
			const url = new URL(request.url);
			const [_, apiCheck, uploadsCheck, uploaderId, partNumberString] = url.pathname.split('/');
			if (apiCheck === 'api' && uploadsCheck === 'uploads' && this.identifier === uploaderId) {
				const partNumber = parseInt(partNumberString);
				const mpu = this._multiPartUpload;
				if (mpu === undefined) {
					return Response.json({ success: false });
				}
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
