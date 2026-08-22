import Joi from 'joi';

export const registerSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
  password: Joi.string().min(8).required().messages({
    'string.min': 'Password must be at least 8 characters long',
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
  // validate() strips any field not declared here (allowUnknown+stripUnknown) — without
  // these, deviceId/deviceInfo/appVersion were always undefined by the time they reached
  // AuthService.completeLogin, so every login pushed a brand-new session entry instead of
  // updating the existing one for that device: sessions[] grew unbounded and the
  // "revoke a device" feature had nothing meaningful to show.
  deviceId: Joi.string().optional(),
  deviceInfo: Joi.string().optional(),
  appVersion: Joi.string().optional(),
});

export const refreshTokenSchema = Joi.object({
  refreshToken: Joi.string().required().messages({
    'any.required': 'Refresh token is required',
  }),
});
