const express = require('express');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const { getAllManagers, getUsersByManager, getUserById, updateManager, deleteManager } = require('../controllers/userController');

// Public routes
router.get('/managers', authenticate, getAllManagers);
router.get('/by/:managerId/', authenticate, getUsersByManager);
router.get('/:id', authenticate, getUserById);
router.put('/update/:managerId', authenticate, updateManager);
router.delete('/delete/:managerId', authenticate, deleteManager);

module.exports = router;