const UserModel = require('../models/userModel');
const sendEmail = require('../utils/emailService');

// ====================== GET ALL MANAGERS (Admin Only) ======================
const getAllManagers = async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: "Only admin can access all managers"
            });
        }

        const managers = await UserModel.find({ role: 'manager' })
            .select('name email isActive createdAt suspensionReason access')
            .sort({ createdAt: -1 });

        const total = managers.length;
        const active = managers.filter(m => m.isActive).length;
        const inactive = total - active;

        res.status(200).json({
            success: true,
            data: {
                managers,
                stats: {
                    total,
                    active,
                    inactive
                }
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// ====================== GET USERS BY MANAGER ID ======================
const getUsersByManager = async (req, res) => {
    try {
        const { managerId } = req.params;
        const currentUser = req.user;

        // Manager can only see his own users
        if (currentUser.role === 'manager' && currentUser._id.toString() !== managerId) {
            return res.status(403).json({
                success: false,
                message: "You can only view your own users"
            });
        }

        // Admin can view any manager's users
        if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
            return res.status(403).json({ success: false, message: "Access denied" });
        }

        const users = await UserModel.find({
            createdBy: managerId,
            role: 'user'
        })
            .select('name email isActive createdAt suspensionReason')
            .sort({ createdAt: -1 });

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No users found for this manager"
            });
        }

        const total = users.length;
        const active = users.filter(u => u.isActive).length;
        const inactive = total - active;

        res.status(200).json({
            success: true,
            data: {
                users,
                stats: {
                    total,
                    active,
                    inactive
                }
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// ====================== GET SINGLE USER BY ID ======================
const getUserById = async (req, res) => {
    try {
        const { id } = req.params;

        const user = await UserModel.findById(id)
            .select('name email role isActive verified createdBy createdAt suspensionReason');

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        // Access Control
        const currentUser = req.user;

        // Admin can see anyone
        if (currentUser.role === 'admin') {
            return res.status(200).json({ success: true, data: user });
        }

        // Manager can see himself and his users
        if (currentUser.role === 'manager') {
            if (user._id.toString() === currentUser._id.toString() ||
                user.createdBy?.toString() === currentUser._id.toString()) {
                return res.status(200).json({ success: true, data: user });
            }
        }

        // Regular user can only see himself
        if (currentUser.role === 'user' && user._id.toString() === currentUser._id.toString()) {
            return res.status(200).json({ success: true, data: user });
        }

        return res.status(403).json({
            success: false,
            message: "Access denied"
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};


// ====================== UPDATE MANAGER (Admin Only) ======================
const updateManager = async (req, res) => {
    try {
        const { managerId } = req.params;
        const { name, email, isActive, suspensionReason, access } = req.body;

        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: "Only admin can update managers"
            });
        }

        const manager = await UserModel.findById(managerId);

        if (!manager) {
            return res.status(404).json({ success: false, message: "Manager not found" });
        }

        if (manager.role !== 'manager') {
            return res.status(400).json({ success: false, message: "This user is not a manager" });
        }

        let changesMade = false;
        let emailHTML = '';
        let emailSubject = '';

        // Update Name
        if (name) {
            manager.name = name.trim();
            changesMade = true;
        }

        // Update Email
        if (email) {
            const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
            if (!emailRegex.test(email)) {
                return res.status(400).json({ success: false, message: "Invalid email format" });
            }

            const existing = await UserModel.findOne({ email, _id: { $ne: managerId } });
            if (existing) {
                return res.status(409).json({ success: false, message: "Email already in use" });
            }

            manager.email = email.toLowerCase().trim();
            changesMade = true;
        }

        // Update Access
        if (access !== undefined) {
            const validAccess = ['head movement', 'hand movement'];

            if (access === null) {
                manager.access = null;
            } else {
                const accessList = Array.isArray(access) ? access : [access];

                if (accessList.length > 0) {
                    const invalid = accessList.filter((item) => !validAccess.includes(item));
                    if (invalid.length > 0) {
                        return res.status(400).json({
                            success: false,
                            message: "Access must be 'head movement' and/or 'hand movement'"
                        });
                    }
                    manager.access = [...new Set(accessList)];
                } else {
                    manager.access = null;
                }
            }

            await UserModel.updateMany(
                { createdBy: manager._id, role: 'user' },
                { access: manager.access }
            );

            changesMade = true;
        }

        // Update Active Status
        if (typeof isActive === 'boolean') {
            if (!isActive && !suspensionReason) {
                return res.status(400).json({
                    success: false,
                    message: "Suspension reason is required when deactivating"
                });
            }

            manager.isActive = isActive;

            if (isActive) {
                manager.suspensionReason = null;
                emailSubject = "Your Manager Account Has Been Activated";
                emailHTML = `
                    <h2>Account Activated</h2>
                    <p>Hello ${manager.name},</p>
                    <p>Your manager account has been activated by Admin.</p>
                `;
            } else {
                manager.suspensionReason = suspensionReason.trim();
                emailSubject = "Your Manager Account Has Been Suspended";
                emailHTML = `
                    <h2>Account Suspended</h2>
                    <p>Hello ${manager.name},</p>
                    <p>Your manager account has been deactivated.</p>
                    <p><strong>Reason:</strong> ${suspensionReason}</p>
                `;
            }

            // If deactivating manager → deactivate all his users
            if (!isActive) {
                await UserModel.updateMany(
                    { createdBy: manager._id, role: 'user' },
                    {
                        isActive: false,
                        suspensionReason: `Deactivated because your manager (${manager.name}) was suspended`
                    }
                );
            }
            // If activating manager → activate all his users
            else {
                await UserModel.updateMany(
                    { createdBy: manager._id, role: 'user' },
                    { isActive: true, suspensionReason: null }
                );
            }

            changesMade = true;
        }

        if (!changesMade) {
            return res.status(400).json({ success: false, message: "No changes provided" });
        }

        await manager.save();

        // Send email if status changed
        if (emailHTML) {
            await sendEmail(manager.email, emailSubject, emailHTML);
        }

        res.status(200).json({
            success: true,
            message: "Manager updated successfully",
            data: {
                managerId: manager._id,
                name: manager.name,
                email: manager.email,
                isActive: manager.isActive,
                access: manager.access,
                suspensionReason: manager.suspensionReason
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// ====================== DELETE MANAGER (Admin Only) ======================
const deleteManager = async (req, res) => {
    try {
        const { managerId } = req.params;

        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: "Only admin can delete managers"
            });
        }

        const manager = await UserModel.findById(managerId);

        if (!manager) {
            return res.status(404).json({ success: false, message: "Manager not found" });
        }

        if (manager.role !== 'manager') {
            return res.status(400).json({ success: false, message: "This user is not a manager" });
        }

        await UserModel.deleteMany({ createdBy: manager._id, role: 'user' });
        await UserModel.findByIdAndDelete(managerId);

        res.status(200).json({
            success: true,
            message: "Manager deleted successfully"
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

module.exports = {
    getAllManagers,
    getUsersByManager,
    getUserById,
    updateManager,
    deleteManager
};