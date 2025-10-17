// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const router = express.Router();

// Generate team code
const generateTeamCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

// Register as Team Leader
router.post('/register-leader', async (req, res) => {
  try {
    const { email, password, name, teamName } = req.body;
    
    // Check if user already exists
    const userExists = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Generate team code
    const teamCode = generateTeamCode();

    // Start transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create user with approved status for leader
      const userResult = await client.query(
        'INSERT INTO users (email, password, name, role, team_code, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [email, hashedPassword, name, 'leader', teamCode, 'approved']
      );

      // Create team
      await client.query(
        'INSERT INTO teams (team_code, team_name, leader_id) VALUES ($1, $2, $3)',
        [teamCode, teamName, userResult.rows[0].id]
      );

      await client.query('COMMIT');
      
      res.json({ 
        message: 'Registration successful', 
        teamCode: teamCode,
        user: userResult.rows[0]
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register as Team Member
router.post('/register-member', async (req, res) => {
  try {
    const { email, password, name, teamCode } = req.body;
    
    // Check if team exists
    const teamExists = await pool.query(
      'SELECT * FROM teams WHERE team_code = $1',
      [teamCode]
    );
    
    if (teamExists.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid team code' });
    }

    // Check if user already exists
    const userExists = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user with pending status
    const userResult = await pool.query(
      'INSERT INTO users (email, password, name, role, team_code, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, name, role, team_code, status',
      [email, hashedPassword, name, 'member', teamCode, 'pending']
    );

    res.json({ 
      message: 'Registration successful! Please wait for team leader approval.',
      user: userResult.rows[0]
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password, teamCode } = req.body;

    // Find user
    const userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND team_code = $2',
      [email, teamCode]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check member status
    if (user.role === 'member' && user.status !== 'approved') {
      if (user.status === 'pending') {
        return res.status(403).json({ 
          error: 'Your membership is pending approval from the team leader' 
        });
      } else if (user.status === 'rejected') {
        return res.status(403).json({ 
          error: 'Your membership request was rejected. Please contact your team leader.' 
        });
      }
    }

    // Remove password from user object
    const { password: _, ...userWithoutPassword } = user;

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      user: userWithoutPassword,
      token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check member status before login
router.post('/check-member-status', async (req, res) => {
  try {
    const { email, teamCode } = req.body;

    if (!email || !teamCode) {
      return res.status(400).json({ error: 'Email and team code are required' });
    }

    const result = await pool.query(
      `SELECT id, name, email, role, status 
       FROM users 
       WHERE email = $1 AND team_code = $2`,
      [email, teamCode]
    );

    if (result.rows.length === 0) {
      return res.json({
        canLogin: false,
        message: 'No account found with these credentials'
      });
    }

    const user = result.rows[0];

    // For leaders, always allow login
    if (user.role === 'leader') {
      return res.json({
        canLogin: true,
        status: 'approved',
        role: 'leader'
      });
    }

    // For members, check status
    if (user.role === 'member') {
      if (user.status === 'pending') {
        return res.json({
          canLogin: false,
          status: 'pending',
          message: 'Membership pending approval'
        });
      } else if (user.status === 'rejected') {
        return res.json({
          canLogin: false,
          status: 'rejected',
          message: 'Membership request rejected'
        });
      } else if (user.status === 'approved') {
        return res.json({
          canLogin: true,
          status: 'approved',
          role: 'member'
        });
      }
    }

    // Default deny
    return res.json({
      canLogin: false,
      message: 'Unable to login'
    });

  } catch (error) {
    console.error('Check member status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get team members (ONLY approved members - EXCLUDE LEADERS)
router.get('/team/:teamCode/all-members', async (req, res) => {
  try {
    const { teamCode } = req.params;

    const result = await pool.query(
      `SELECT id, name, email, role, status, created_at,
              (SELECT COUNT(*) FROM subtasks s WHERE s.assigned_to = users.id) as assigned_tasks,
              (SELECT COUNT(*) FROM subtasks s WHERE s.assigned_to = users.id AND s.status = 'completed') as completed_tasks
       FROM users 
       WHERE team_code = $1 AND role = 'member' AND status = 'approved'
       ORDER BY created_at DESC`,
      [teamCode]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get team members error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get pending approval requests for a team (ONLY pending members - EXCLUDE LEADERS)
router.get('/team/:teamCode/pending-requests', async (req, res) => {
  try {
    const { teamCode } = req.params;

    const result = await pool.query(
      `SELECT id, name, email, created_at 
       FROM users 
       WHERE team_code = $1 AND status = 'pending' AND role = 'member'
       ORDER BY created_at DESC`,
      [teamCode]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get pending requests error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get rejected members for a team (ONLY rejected members - EXCLUDE LEADERS)
router.get('/team/:teamCode/rejected-members', async (req, res) => {
  try {
    const { teamCode } = req.params;

    const result = await pool.query(
      `SELECT id, name, email, created_at, updated_at 
       FROM users 
       WHERE team_code = $1 AND status = 'rejected' AND role = 'member'
       ORDER BY updated_at DESC`,
      [teamCode]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get rejected members error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve a member
router.post('/approve-member', async (req, res) => {
  try {
    const { userId, teamCode, approvedBy } = req.body;

    if (!userId || !teamCode || !approvedBy) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update user status to approved
      const result = await client.query(
        'UPDATE users SET status = $1, approved_by = $2, approved_at = NOW(), updated_at = NOW() WHERE id = $3 AND team_code = $4 AND role = $5 RETURNING *',
        ['approved', approvedBy, userId, teamCode, 'member']
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found or already processed' });
      }

      await client.query('COMMIT');

      res.json({ 
        message: 'Member approved successfully', 
        user: result.rows[0] 
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Approve member error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reject a member
router.post('/reject-member', async (req, res) => {
  try {
    const { userId, teamCode, rejectedBy } = req.body;

    if (!userId || !teamCode || !rejectedBy) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update user status to rejected
      const result = await client.query(
        'UPDATE users SET status = $1, rejected_by = $2, rejected_at = NOW(), updated_at = NOW() WHERE id = $3 AND team_code = $4 AND role = $5 RETURNING *',
        ['rejected', rejectedBy, userId, teamCode, 'member']
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found or already processed' });
      }

      await client.query('COMMIT');

      res.json({ 
        message: 'Member request rejected', 
        user: result.rows[0] 
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Reject member error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve a previously rejected member
router.post('/approve-rejected-member', async (req, res) => {
  try {
    const { userId, teamCode, approvedBy } = req.body;

    if (!userId || !teamCode || !approvedBy) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update user status from rejected to approved
      const result = await client.query(
        'UPDATE users SET status = $1, approved_by = $2, approved_at = NOW(), rejected_by = NULL, rejected_at = NULL, updated_at = NOW() WHERE id = $3 AND team_code = $4 AND status = $5 AND role = $6 RETURNING *',
        ['approved', approvedBy, userId, teamCode, 'rejected', 'member']
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Rejected member not found or already processed' });
      }

      await client.query('COMMIT');

      res.json({ 
        message: 'Member approved successfully', 
        user: result.rows[0] 
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Approve rejected member error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete rejected member permanently
router.delete('/delete-rejected-member/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 AND status = $2 AND role = $3 RETURNING *',
      [userId, 'rejected', 'member']
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rejected member not found' });
    }

    res.json({ 
      message: 'Rejected member deleted permanently', 
      user: result.rows[0] 
    });
  } catch (error) {
    console.error('Delete rejected member error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete team member (leader only)
router.delete('/team/:teamCode/member/:memberId', async (req, res) => {
  try {
    const { teamCode, memberId } = req.params;
    const { leaderId } = req.body;

    if (!leaderId) {
      return res.status(400).json({ error: 'Leader ID is required' });
    }

    // Verify requester is team leader
    const leaderCheck = await pool.query(
      'SELECT id, role FROM users WHERE id = $1 AND team_code = $2 AND role = $3',
      [leaderId, teamCode, 'leader']
    );

    if (leaderCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Only team leader can delete members' });
    }

    // Prevent leader from deleting themselves
    if (parseInt(memberId) === parseInt(leaderId)) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    // Check if member exists and belongs to the team
    const memberCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND team_code = $2 AND role = $3',
      [memberId, teamCode, 'member']
    );

    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found in your team' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Remove member from assigned subtasks
      await client.query(
        'UPDATE subtasks SET assigned_to = NULL, status = $1 WHERE assigned_to = $2',
        ['available', memberId]
      );

      // Delete member
      await client.query('DELETE FROM users WHERE id = $1', [memberId]);

      await client.query('COMMIT');

      res.json({ message: 'Member deleted successfully' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Delete member error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get basic team members (for backward compatibility)
router.get('/team/:teamCode/members', async (req, res) => {
  try {
    const { teamCode } = req.params;
    
    const membersResult = await pool.query(
      'SELECT id, name, email, role, created_at FROM users WHERE team_code = $1 AND role = $2 AND status = $3 ORDER BY name',
      [teamCode, 'member', 'approved']
    );

    res.json(membersResult.rows);
  } catch (error) {
    console.error('Get team members error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;