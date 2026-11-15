import mongoose, { Schema, Document } from 'mongoose';

export interface IAuditLog extends Document {
  userId?: mongoose.Types.ObjectId;
  action: string;
  resource: string;
  resourceId?: string;
  oldValue?: any;
  newValue?: any;
  status: 'success' | 'failure';
  ip?: string;
  userAgent?: string;
  metadata?: any;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    resource: {
      type: String,
      required: true,
      index: true,
    },
    resourceId: {
      type: String,
      index: true,
    },
    oldValue: Schema.Types.Mixed,
    newValue: Schema.Types.Mixed,
    status: {
      type: String,
      enum: ['success', 'failure'],
      default: 'success',
      index: true,
    },
    ip: String,
    userAgent: String,
    metadata: Schema.Types.Mixed,
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// TTL index controlling how long audit logs are kept before automatic deletion.
// Default is 5 years (1825 days), a common baseline for AML/financial
// recordkeeping — but the actual retention period is a regulatory decision
// specific to the jurisdictions Djangui operates in and MUST be confirmed
// (and set via AUDIT_LOG_RETENTION_DAYS) rather than relied on as-is.
const AUDIT_LOG_RETENTION_DAYS = Number(process.env.AUDIT_LOG_RETENTION_DAYS) || 1825;
auditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 },
);

// Immutabilité stricte au niveau du schéma (F11) : interdiction absolue de mise à jour ou suppression.
// La liste couvre explicitement findOneAndDelete/findOneAndRemove — des hooks Mongoose
// distincts de deleteOne/deleteMany qui, omis, laisseraient un contournement trivial de
// cette garde (AuditLog.findOneAndDelete() passerait sans erreur).
auditLogSchema.pre(
  [
    'updateOne',
    'findOneAndUpdate',
    'updateMany',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
    'findOneAndRemove',
  ] as any,
  function (this: any, next: any) {
    next(new Error('AuditLog entries are immutable and cannot be updated or deleted.'));
  },
);

const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);

export default AuditLog;
