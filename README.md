# Upload Large Files to R2 Object Storage using Actors

[R2](https://developers.cloudflare.com/r2) is a zero egress fee S3 compatible object storage solution. It is ideal for large AI training datasets. If you've ever tried to allow your users large datasets via a web browser, you know it can be challenging. Networks can be faulty, and resuming operations is often needed.

[Workers](https://) are powerful, but they are limited to the amount of data that they can pass. A common solution is to use the [R2 Multipart Uploads](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/). However maintaining state of the upload can be challenging.

This examples leans on the [Actors](https://github.com/cloudflare/actors) library to create a new Actor named [Uploader](./src/actors/uploader.ts). It is used in conjunction with a [Hono](https://honojs.dev) based [API](./src/index.ts) that the [front end](./public/) interacts with to upload large files.

You can stop and resume file uploading using information stored in a Hono session.

## Develop

```bash
npm install
```

```bash
npx wrangler r2 bucket create biggies
```

## Deploy

```bash
npm run deploy
```

__NOTE__: This application's front-end was built with [Claude Code](https://claude.ai/code) and the prompts have been stored in the [truth-window](./truth-window/) folder.
