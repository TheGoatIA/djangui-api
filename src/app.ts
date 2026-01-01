import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import errorHandler from './middleware/errorHandler';
import requestLogger from './middleware/requestLogger';

dotenv.config();

const app = express();

// Middlewares
app.use(requestLogger);
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes (placeholder)
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
