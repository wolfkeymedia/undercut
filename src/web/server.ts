import { createServer } from "node:http";
import { createApp } from "./app.js";

/** Runs the hosted app locally: `npm run web`, then open http://localhost:3000. */
const port = Number(process.env.PORT ?? 3000);
createServer(createApp()).listen(port, () => console.log(`Undercut is running on http://localhost:${port}`));
