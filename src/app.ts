import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import errorHandler from './middleware/errorHandler';
import requestLogger from './middleware/requestLogger';
import routes from './routes';

dotenv.config();

const app = express();

// Middlewares
app.use(requestLogger);
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({
    verify: (req: any, res, buf) => {
        if (req.originalUrl.includes('/webhooks/stripe')) {
            req.rawBody = buf;
        }
    }
}));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api/v1', routes);

app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'success',
        message: 'Djangui API is healthy',
        timestamp: new Date().toISOString(),
    });
});

// Error handling
app.use(errorHandler);

export default app;
