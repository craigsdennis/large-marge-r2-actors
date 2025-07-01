import { Hono } from 'hono';
import { useSession } from '@hono/session';
import type { SessionEnv } from '@hono/session';
import { Uploader } from './actors/uploader';

export { Uploader };

const app = new Hono<SessionEnv & { Bindings: Env }>();

app.use(useSession());

app.post('/api/uploads', async (c) => {
	const payload = await c.req.json();
	// FileName, Size
	// Create new uploader, return the key
	// TODO: We are going to want to use the c.var.session.id
	const uploaderId = c.env.UPLOADER.newUniqueId();
	const uploaderStub = c.env.UPLOADER.get(uploaderId);
	const partRequests = await uploaderStub.initialize(payload.fileName, payload.fileSize);
	const data = await c.var.session.get();
	if (data) {
		data.latestUploaderId = uploaderId.toString();
		await c.var.session.update(data);
	}
	return c.json({
		uploaderId: uploaderId.toString(),
		partRequests
	});
});

app.get('/api/uploads/:id', async (c) => {
	// Get the missing parts
	// Sessions for Hono?
});

// TODO: Resume and Done

app.patch('/api/uploads/:id/:part_number', async (c) => {
	// Get the Actor
	// Pass request through into fetch
	// Return success result
});

export default app;
