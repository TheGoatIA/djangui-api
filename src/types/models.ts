export interface IUser {
    email: string;
    password?: string;
    firstName: string;
    lastName: string;
    phone?: string;
    avatar?: string;
    monthlyIncome: number;
    currency: string;
    language: string;
    preferences: {
        coachTone: 'encouraging' | 'firm' | 'balanced';
        notificationFrequency: 'high' | 'medium' | 'low';
        budgetAlertThreshold: number;
    };
    subscription: {
        plan: 'free' | 'premium';
        status: 'active' | 'cancelled' | 'expired';
        startDate?: Date;
        endDate?: Date;
        autoRenew: boolean;
    };
    isEmailVerified: boolean;
    isActive: boolean;
    fcmTokens: string[];
    lastLogin?: Date;
    refreshToken?: string;
    createdAt: Date;
    updatedAt: Date;
}
