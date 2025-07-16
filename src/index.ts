import { Context, Hono } from 'hono';
import { useSession } from '@hono/session';
import type { Session, SessionData, SessionEnv, Storage } from '@hono/session';
import { Uploader } from './actors/uploader';
import { BlankInput } from 'hono/types';

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
	// const uploaderId = c.env.UPLOADER.idFromName(uploaderIdString);
	// const uploaderStub = c.env.UPLOADER.get(uploaderId);
	const uploaderStub = Uploader.get(uploaderIdString);
	//await uploaderStub?.setIdentifier(uploaderIdString);
	if (uploaderStub === undefined) {
		console.error("Missing uploader stub", uploaderIdString);
		return c.json({success: false, error: "Uploader Stub not returned"}, 500);
	}
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
	// const uploaderId = c.env.UPLOADER.idFromName(id);
	// const uploaderStub = c.env.UPLOADER.get(uploaderId);
	const uploaderStub = Uploader.get(id);
	const partRequests = await uploaderStub?.getMissingPartRequests();
	return Response.json({
		partRequests,
	});
});

async function cleanup(c: Context<EnvWithSession>, uploaderStub: DurableObjectStub<Uploader>) {
	c.var.session.delete();
	try {
		await uploaderStub.destroy();
	} catch(e) {
		console.warn("Evicted stub", e);
	}
	console.log("Cleaned up session and Actor data");
}

app.patch('/api/uploads/:id/:part_number', async (c) => {
	// Get the Actor
	const { id } = c.req.param();
	// const uploaderId = c.env.UPLOADER.idFromName(id);
	// const uploaderStub = c.env.UPLOADER.get(uploaderId);
	const uploaderStub = Uploader.get(id);
	// Pass request through into fetch
	const response = await uploaderStub?.fetch(c.req.raw);
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
