const express = require('express');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const {
    getAllManagers,
    getUsersByManager,
    getUserById,
    updateManager,
    deleteManager,
    deleteClientUser
} = require('../controllers/userController');

router.get('/managers', authenticate, getAllManagers);
router.get('/by/:managerId/', authenticate, getUsersByManager);
router.get('/:id', authenticate, getUserById);
router.put('/update/:managerId', authenticate, updateManager);
router.delete('/delete/:managerId', authenticate, deleteManager);
router.delete('/client/:userId', authenticate, deleteClientUser);

module.exports = router;