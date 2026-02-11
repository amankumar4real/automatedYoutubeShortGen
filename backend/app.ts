import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import routes from './routes';
import { errorHandler } from './middleware';
import { config } from './config';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use(routes);

// Static media (videos + metadata JSON)
app.use('/media', express.static(path.join(config.workspaceRoot, 'output')));

app.use(errorHandler);

export default app;
