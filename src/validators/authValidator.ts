import Joi from 'joi';

const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
const PASSWORD_ERROR_MSG =
  'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character';

export const registerSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
  password: Joi.string().pattern(PASSWORD_REGEX).required().messages({
    'string.pattern.base': PASSWORD_ERROR_MSG,
    'any.required': 'Password is required',
  }),
  firstName: Joi.string().required().messages({
    'any.required': 'First name is required',
  }),
  lastName: Joi.string().required().messages({
    'any.required': 'Last name is required',
  }),
  phone: Joi.string().optional(),
  country: Joi.string().length(2).uppercase().optional(),
});

export const loginSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
  password: Joi.string().required().messages({
    'any.required': 'Password is required',
  }),
  deviceId: Joi.string().optional(),
  deviceInfo: Joi.object({
    model: Joi.string().allow('').optional(),
    os: Joi.string().allow('').optional(),
    osVersion: Joi.string().allow('').optional(),
    platform: Joi.string().valid('android', 'ios', 'web').optional(),
  }).optional(),
  appVersion: Joi.string().optional(),
});

export const refreshTokenSchema = Joi.object({
  refreshToken: Joi.string().required().messages({
    'any.required': 'Refresh token is required',
  }),
});

export const resetPasswordSchema = Joi.object({
  password: Joi.string().pattern(PASSWORD_REGEX).required().messages({
    'string.pattern.base': PASSWORD_ERROR_MSG,
    'any.required': 'Password is required',
  }),
});

export const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required().messages({
    'any.required': 'Current password is required',
  }),
  newPassword: Joi.string().pattern(PASSWORD_REGEX).required().messages({
    'string.pattern.base': PASSWORD_ERROR_MSG,
    'any.required': 'New password is required',
  }),
});
