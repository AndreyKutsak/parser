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
  type:     Joi.string().valid('wireguard', 'openvpn').default('wireguard'),
  name:     Joi.string().max(100).allow('', null),
  config:   Joi.string().max(60000).required().messages({ 'any.required': 'Вставте конфіг VPN (.conf або .ovpn)' }),
  username: Joi.string().max(200).allow('', null), // OpenVPN: якщо в .ovpn є auth-user-pass
  password: Joi.string().max(200).allow('', null),
  tags:     Joi.array().items(Joi.string()).default([]),
  note:     Joi.string().max(500).allow('', null),
});

const vpnUpdateSchema = Joi.object({
  name:       Joi.string().max(100).allow('', null),
  config:     Joi.string().max(60000).allow('', null), // порожній — лишається старий конфіг
  username:   Joi.string().max(200).allow('', null),
  password:   Joi.string().max(200).allow('', null), // порожній — лишається старий пароль
  vpnEnabled: Joi.boolean(),
  tags:       Joi.array().items(Joi.string()),
  note:       Joi.string().max(500).allow('', null),
});

const vpnGateImportSchema = Joi.object({
  country:    Joi.string().pattern(/^[a-z]{2}$/).default('ua'),
  enable:     Joi.number().integer().min(0).max(50).default(5), // скільки нових тунелів одразу увімкнути
  maxServers: Joi.number().integer().min(1).max(500).default(300),
});

module.exports = {
  validateProxy: validate(proxySchema),
  validateImport: validate(importSchema),
  validateVpnCreate: validate(vpnCreateSchema),
  validateVpnUpdate: validate(vpnUpdateSchema),
  validateVpnGateImport: validate(vpnGateImportSchema),
};
