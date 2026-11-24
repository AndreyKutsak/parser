const Joi = require('joi');

const proxySchema = Joi.object({
  host:     Joi.string().hostname().required(),
  port:     Joi.number().integer().min(1).max(65535).required(),
  protocol: Joi.string().valid('http', 'https', 'socks4', 'socks5').default('http'),
  username: Joi.string().allow('', null),
  password: Joi.string().allow('', null),
  country:  Joi.string().length(2).uppercase().allow('', null),
  tags:     Joi.array().items(Joi.string()).default([]),
  note:     Joi.string().max(500).allow('', null),
});

const importSchema = Joi.object({
  text:     Joi.string().required().messages({ 'any.required': 'Proxy list text is required' }),
  protocol: Joi.string().valid('http', 'https', 'socks4', 'socks5').default('http'),
  username: Joi.string().allow('', null),
  password: Joi.string().allow('', null),
});

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: error.details.map(d => ({ field: d.path.join('.'), message: d.message })),
    });
  }
  req.body = value;
  next();
};

const vpnCreateSchema = Joi.object({
  name:   Joi.string().max(100).allow('', null),
  config: Joi.string().max(20000).required().messages({ 'any.required': 'Вставте WireGuard-конфіг (.conf)' }),
  tags:   Joi.array().items(Joi.string()).default([]),
  note:   Joi.string().max(500).allow('', null),
});

const vpnUpdateSchema = Joi.object({
  name:       Joi.string().max(100).allow('', null),
  config:     Joi.string().max(20000).allow('', null), // порожній — лишається старий конфіг
  vpnEnabled: Joi.boolean(),
  tags:       Joi.array().items(Joi.string()),
  note:       Joi.string().max(500).allow('', null),
});

module.exports = {
  validateProxy: validate(proxySchema),
  validateImport: validate(importSchema),
  validateVpnCreate: validate(vpnCreateSchema),
  validateVpnUpdate: validate(vpnUpdateSchema),
};
