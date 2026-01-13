import { Response, NextFunction } from 'express';
import { SimulatorService } from '../services/ai/simulatorService';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

export class SimulatorController {
    /**
     * Run a "What If?" financial simulation
     */
    static async simulate(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const { scenario } = req.body;
            if (!scenario) {
                throw new AppError('Scenario description is required.', 400);
            }

            const simulation = await SimulatorService.simulateScenario(req.user._id, scenario);

            res.status(200).json({
                success: true,
                data: simulation,
            });
        } catch (err) {
            next(err);
        }
    }
}
