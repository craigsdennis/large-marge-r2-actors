import { Hono } from 'hono';
import { useSession } from '@hono/session';
import type { SessionEnv } from '@hono/session';
import { Uploader } from './actors/uploader';

export { Uploader };

const app = new Hono<SessionEnv & { Bindings: Env }>();

app.use(useSession());

app.get('/api/resume', async(c) => {
	const data = await c.var.session.get();
	if (data?.latestUploaderId) {
		return c.json({
			latestUploaderId: data.latestUploaderId,
			lastUploadedFileName: data.lastUploadedFileName,
			remainingCount: data.remainingCount,
		});
	}
	return c.json({});
})

app.post('/api/uploads', async (c) => {
	const payload = await c.req.json();
	const uploaderId = c.env.UPLOADER.newUniqueId();
	const uploaderStub = c.env.UPLOADER.get(uploaderId);
	await uploaderStub.initialize(payload.fileName, payload.fileSize);
	const partRequests = await uploaderStub.getMissingPartRequests();
	const data = await c.var.session.get();
	if (data) {
		data.latestUploaderId = uploaderId.toString();
		data.lastUploadedFileName = payload.fileName;
		await c.var.session.update(data);
	}
	return c.json({
		uploaderId: uploaderId.toString(),
		partRequests
	});
});

app.get('/api/uploads/:id', async (c) => {
	const {id} = c.req.param();
	const uploaderId = c.env.UPLOADER.idFromString(id);
	const uploaderStub = c.env.UPLOADER.get(uploaderId);
	const partRequests = uploaderStub.getMissingPartRequests();
	return Response.json({
		partRequests
	});
});

async function cleanup(c) {
	await c.var.session.delete();
}

app.patch('/api/uploads/:id/:part_number', async (c) => {
	// Get the Actor
	const {id} = c.req.param();
	const uploaderId = c.env.UPLOADER.idFromString(id);
	const uploaderStub = c.env.UPLOADER.get(uploaderId);
	// Pass request through into fetch
	const response = await uploaderStub.fetch(c.req.raw);
	const {remainingCount} = await response.json<{remainingCount: number}>();
	const data = await c.var.session.get();
	if (data) {
		if (remainingCount === 0) {
			await cleanup(c);
		} else {
			data.remainingCount = remainingCount;
			await c.var.session.update(data);
		}
	}
	return c.json(remainingCount);
});

export default app;
