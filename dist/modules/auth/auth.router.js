"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../../core/auth.middleware");
const auth_controller_1 = require("./auth.controller");
const router = (0, express_1.Router)();
exports.authRouter = router;
router.get('/login', auth_controller_1.showLogin);
router.post('/login', auth_controller_1.handleLogin);
router.post('/logout', auth_controller_1.handleLogout);
router.get('/settings/change-password', auth_middleware_1.requireAuthOnly, auth_controller_1.showChangePassword);
router.post('/settings/change-password', auth_middleware_1.requireAuthOnly, auth_controller_1.handleChangePassword);
//# sourceMappingURL=auth.router.js.map