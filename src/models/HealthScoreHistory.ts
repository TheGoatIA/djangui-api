import mongoose, { Document, Schema } from 'mongoose';

// Un point par utilisateur/mois/année — persiste ce que le rapport narratif IA
// (ReportService.getNarrativeReport) calcule pour `health_score`, qui sinon ne
// vit que 6h dans le cache Redis du rapport et est reperdu ensuite. Sert
// uniquement à tracer la courbe d'évolution mois par mois côté mobile.
export interface IHealthScoreHistory extends Document {
  userId: mongoose.Types.ObjectId;
  month: number;
  year: number;
  score: number;
  computedAt: Date;
}

const healthScoreHistorySchema = new Schema<IHealthScoreHistory>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  year: { type: Number, required: true },
  score: { type: Number, required: true, min: 0, max: 100 },
  computedAt: { type: Date, default: Date.now },
});

healthScoreHistorySchema.index({ userId: 1, year: 1, month: 1 }, { unique: true });

const HealthScoreHistory = mongoose.model<IHealthScoreHistory>(
  'HealthScoreHistory',
  healthScoreHistorySchema,
);

export default HealthScoreHistory;
