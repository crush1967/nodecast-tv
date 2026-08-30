const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../auth');

/**
 * Get all users (admin only)
 * GET /api/users
 */
router.get('/', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const data = await db.loadDb();
        const users = (data.users || []).map(u => ({
            id: u.id,
            username: u.username,
            role: u.role,
            createdAt: u.createdAt
        }));
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Create user (admin only)
 * POST /api/users
 */
router.post('/', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { username, password, role } = req.body;
        
        if (!username || !password || !role) {
            return res.status(400).json({ error: 'Username, password, and role required' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        if (!['admin', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'Role must be admin or viewer' });
        }
        
        // Hash before entering the transaction - it's slow (bcrypt) and doesn't
        // need to hold up the db lock while it runs.
        const passwordHash = await auth.hashPassword(password);

        const newUser = await db.transaction(data => {
            if (data.users?.some(u => u.username === username)) {
                throw Object.assign(new Error('Username already exists'), { status: 400 });
            }

            const user = {
                id: data.nextUserId || (data.users?.length || 0) + 1,
                username,
                passwordHash,
                role,
                createdAt: new Date().toISOString()
            };

            data.users = data.users || [];
            data.users.push(user);
            data.nextUserId = user.id + 1;
            return user;
        });

        res.json({
            id: newUser.id,
            username: newUser.username,
            role: newUser.role,
            createdAt: newUser.createdAt
        });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
    }
});

/**
 * Update user (admin only)
 * PUT /api/users/:id
 */
router.put('/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const { username, password, role } = req.body;

        const fail = (status, error) => { throw Object.assign(new Error(error), { status }); };

        const user = await db.transaction(async data => {
            const userIndex = data.users?.findIndex(u => u.id === userId);
            if (userIndex === -1 || userIndex === undefined) {
                fail(404, 'User not found');
            }

            const user = data.users[userIndex];

            // Update username if provided
            if (username && username !== user.username) {
                if (data.users.some(u => u.username === username && u.id !== userId)) {
                    fail(400, 'Username already exists');
                }
                user.username = username;
            }

            // Update password if provided
            if (password) {
                if (password.length < 6) {
                    fail(400, 'Password must be at least 6 characters');
                }
                user.passwordHash = await auth.hashPassword(password);
            }

            // Update role if provided
            if (role) {
                if (!['admin', 'viewer'].includes(role)) {
                    fail(400, 'Role must be admin or viewer');
                }

                // Prevent removing last admin
                if (user.role === 'admin' && role !== 'admin') {
                    const adminCount = data.users.filter(u => u.role === 'admin').length;
                    if (adminCount <= 1) {
                        fail(400, 'Cannot remove last admin user');
                    }
                }

                user.role = role;
            }

            return user;
        });

        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            createdAt: user.createdAt
        });
    } catch (err) {
        console.error('Update user error:', err);
        res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
    }
});

/**
 * Delete user (admin only)
 * DELETE /api/users/:id
 */
router.delete('/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const fail = (status, error) => { throw Object.assign(new Error(error), { status }); };

        await db.transaction(data => {
            const userIndex = data.users?.findIndex(u => u.id === userId);
            if (userIndex === -1 || userIndex === undefined) {
                fail(404, 'User not found');
            }

            const user = data.users[userIndex];

            // Prevent deleting yourself
            if (user.id === req.session.userId) {
                fail(400, 'Cannot delete your own account');
            }

            // Prevent deleting last admin
            if (user.role === 'admin') {
                const adminCount = data.users.filter(u => u.role === 'admin').length;
                if (adminCount <= 1) {
                    fail(400, 'Cannot delete last admin user');
                }
            }

            data.users.splice(userIndex, 1);
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Delete user error:', err);
        res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
    }
});

module.exports = router;
