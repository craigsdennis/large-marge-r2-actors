import { Hono } from 'hono';
import { useSession } from '@hono/session';
import type { SessionEnv } from '@hono/session';
import { Uploader } from './actors/uploader';

export { Uploader };

const app = new Hono<SessionEnv & { Bindings: Env }>();

app.use(useSession());

app.post('/api/uploads', async (c) => {
	const payload = await c.req.json();
	// Create new uploader, return the key
	// TODO: We are going to want to use the c.var.session.id
	console.log("Before");
	const uploaderId = c.env.UPLOADER.newUniqueId();
	const uploaderStub = c.env.UPLOADER.get(uploaderId);
	console.log("Post constructor");
	await uploaderStub.initialize(payload.fileName, payload.fileSize);
	console.log("Post Initialize");
	const partRequests = await uploaderStub.getMissingPartRequests();
	console.log("Post partRequests");
	const data = await c.var.session.get();
	if (data) {
		data.latestUploaderId = uploaderId.toString();
		await c.var.session.update(data);
	}
	// TODO: Do not pass the uploader ID
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

app.patch('/api/uploads/:id/:part_number', async (c) => {
	// Get the Actor
	const {id} = c.req.param();
	const uploaderId = c.env.UPLOADER.idFromString(id);
	const uploaderStub = c.env.UPLOADER.get(uploaderId);
	// Pass request through into fetch
	return await uploaderStub.fetch(c.req.raw);
});

export default app;
