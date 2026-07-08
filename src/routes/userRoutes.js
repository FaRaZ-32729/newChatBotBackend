const express = require('express');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const {
    getAllManagers,
    getUsersByManager,
    getUserById,
    getManagerDetails,
    updateManager,
    deleteManager,
    deleteClientUser
} = require('../controllers/userController');

router.get('/managers', authenticate, getAllManagers);
router.get('/by/:managerId/', authenticate, getUsersByManager);
// Full manager page data for admin (chatbots + users together)
router.get('/manager-details/:managerId', authenticate, getManagerDetails);
router.get('/:id', authenticate, getUserById);
router.put('/update/:managerId', authenticate, updateManager);
router.delete('/delete/:managerId', authenticate, deleteManager);
router.delete('/client/:userId', authenticate, deleteClientUser);

module.exports = router;