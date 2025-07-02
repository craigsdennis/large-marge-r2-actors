import { Context, Hono } from 'hono';
import { useSession } from '@hono/session';
import type { Session, SessionData, SessionEnv, Storage } from '@hono/session';
import { Uploader } from './actors/uploader';

export { Uploader };

type EnvWithSession = {Bindings: Env} & SessionEnv;
const app = new Hono<EnvWithSession>();

app.use(useSession());

app.get('/api/resume', async (c) => {
	const data = await c.var.session.get();
	if (data?.latestUploaderId) {
		return c.json({
			latestUploaderId: data.latestUploaderId,
			lastUploadedFileName: data.lastUploadedFileName,
			remainingCount: data.remainingCount,
		});
	}
	return c.json({});
});

app.post('/api/uploads', async (c) => {
	const payload = await c.req.json();
	const uploaderIdString = crypto.randomUUID();
	const uploaderId = c.env.UPLOADER.idFromName(uploaderIdString);
	const uploaderStub = c.env.UPLOADER.get(uploaderId);
	await uploaderStub.setIdentifier(uploaderIdString);
	await uploaderStub.initialize(payload.fileName, payload.fileSize);
	const partRequests = await uploaderStub.getMissingPartRequests();
	const data = await c.var.session.get();
	if (data) {
		data.latestUploaderId = uploaderIdString;
		data.lastUploadedFileName = payload.fileName;
		await c.var.session.update(data);
	}
	return c.json({
		uploaderId: uploaderIdString,
		partRequests,
	});
});

app.get('/api/uploads/:id', async (c) => {
	const { id } = c.req.param();
	const uploaderId = c.env.UPLOADER.idFromName(id);
	const uploaderStub = c.env.UPLOADER.get(uploaderId);
	const partRequests = await uploaderStub.getMissingPartRequests();
	return Response.json({
		partRequests,
	});
});

async function cleanup(c, uploaderStub: DurableObjectStub<Uploader>) {
	await c.var.session.delete();
	await uploaderStub.cleanup();
	console.log("Cleaned up session and Actor data");
}

app.patch('/api/uploads/:id/:part_number', async (c) => {
	// Get the Actor
	const { id } = c.req.param();
	const uploaderId = c.env.UPLOADER.idFromName(id);
	const uploaderStub = c.env.UPLOADER.get(uploaderId);
	// Pass request through into fetch
	const response = await uploaderStub.fetch(c.req.raw);
	if (!response.ok) {
		throw new Error("Patch failed");
	}
	const { remainingCount } = await response.json<{ remainingCount: number }>();
	const data = await c.var.session.get();
	if (data) {
		if (remainingCount === 0) {
			await cleanup(c, uploaderStub);
		} else {
			data.remainingCount = remainingCount;
			await c.var.session.update(data);
		}
	}
	return c.json(remainingCount);
});

export default app;
