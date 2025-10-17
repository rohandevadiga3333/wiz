// routes/tasks.js
const express = require('express');
const { pool } = require('../db');
const router = express.Router();

// Create task with subtasks
router.post('/create', async (req, res) => {
  try {
    const { title, description, teamCode, createdBy, subtasks, assignSpecific } = req.body;

    if (!title || !teamCode || !createdBy || !subtasks || subtasks.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create main task
      const taskResult = await client.query(
        'INSERT INTO tasks (title, description, team_code, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [title, description, teamCode, createdBy]
      );

      const taskId = taskResult.rows[0].id;

      // Create subtasks
      for (const subtask of subtasks) {
        let status = 'available';
        let assignedTo = null;
        let progress = 'not_started';
        
        // If assignment is specified, mark as assigned
        if (assignSpecific && subtask.assigned_to) {
          status = 'assigned';
          assignedTo = subtask.assigned_to;
          progress = 'assigned';
        }

        await client.query(
          'INSERT INTO subtasks (task_id, title, description, assigned_to, status, progress) VALUES ($1, $2, $3, $4, $5, $6)',
          [taskId, subtask.title, subtask.description || null, assignedTo, status, progress]
        );
      }

      await client.query('COMMIT');
      
      // Get the complete task with subtasks for response
      const completeTask = await getTaskWithSubtasks(taskId);
      
      res.json({ 
        message: 'Task created successfully', 
        task: completeTask 
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Task creation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all tasks for a team
router.get('/team/:teamCode', async (req, res) => {
  try {
    const { teamCode } = req.params;

    const tasksResult = await pool.query(
      `SELECT t.*, u.name as created_by_name,
             (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id) as total_subtasks,
             (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.status = 'completed') as completed_subtasks
       FROM tasks t
       LEFT JOIN users u ON t.created_by = u.id
       WHERE t.team_code = $1
       ORDER BY t.created_at DESC`,
      [teamCode]
    );

    // Get subtasks for each task
    const tasksWithSubtasks = await Promise.all(
      tasksResult.rows.map(async (task) => {
        const subtasks = await getSubtasksForTask(task.id);
        return {
          ...task,
          subtasks: subtasks
        };
      })
    );

    res.json(tasksWithSubtasks);
  } catch (error) {
    console.error('Get tasks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available subtasks for a team (not assigned to anyone)
router.get('/team/:teamCode/available', async (req, res) => {
  try {
    const { teamCode } = req.params;

    const result = await pool.query(
      `SELECT s.*, t.title as task_title, t.description as task_description,
              u.name as created_by_name
       FROM subtasks s
       JOIN tasks t ON s.task_id = t.id
       LEFT JOIN users u ON t.created_by = u.id
       WHERE t.team_code = $1 AND s.status = 'available'
       ORDER BY s.created_at DESC`,
      [teamCode]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get available tasks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single task by ID
router.get('/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;

    const taskResult = await pool.query(
      `SELECT t.*, u.name as created_by_name
       FROM tasks t
       LEFT JOIN users u ON t.created_by = u.id
       WHERE t.id = $1`,
      [taskId]
    );

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];
    task.subtasks = await getSubtasksForTask(taskId);

    res.json(task);
  } catch (error) {
    console.error('Get task error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Member takes a subtask (with confirmation)
router.put('/subtask/:subtaskId/take', async (req, res) => {
  try {
    const { subtaskId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if subtask is still available
      const subtaskCheck = await client.query(
        'SELECT * FROM subtasks WHERE id = $1 FOR UPDATE',
        [subtaskId]
      );

      if (subtaskCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Subtask not found' });
      }

      const subtask = subtaskCheck.rows[0];

      if (subtask.status !== 'available') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This subtask is no longer available' });
      }

      // Assign subtask to user
      const result = await client.query(
        `UPDATE subtasks 
         SET assigned_to = $1, status = $2, progress = $3
         WHERE id = $4 
         RETURNING *`,
        [userId, 'taken', 'in_progress', subtaskId]
      );

      await client.query('COMMIT');

      // Get updated subtask with details
      const updatedSubtask = await getSubtaskWithDetails(subtaskId);

      res.json({ 
        message: 'Subtask assigned to you successfully!', 
        subtask: updatedSubtask 
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Take subtask error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Leader assigns specific subtask to member
router.put('/subtask/:subtaskId/assign-to', async (req, res) => {
  try {
    const { subtaskId } = req.params;
    const { userId, assignedBy } = req.body;

    if (!userId || !assignedBy) {
      return res.status(400).json({ error: 'User ID and assignedBy are required' });
    }

    const result = await pool.query(
      `UPDATE subtasks 
       SET assigned_to = $1, status = $2, progress = $3
       WHERE id = $4 
       RETURNING *`,
      [userId, 'assigned', 'assigned', subtaskId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subtask not found' });
    }

    const updatedSubtask = await getSubtaskWithDetails(subtaskId);

    res.json({ 
      message: 'Subtask assigned to member successfully', 
      subtask: updatedSubtask 
    });
  } catch (error) {
    console.error('Leader assign subtask error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update subtask progress
router.put('/subtask/:subtaskId/progress', async (req, res) => {
  try {
    const { subtaskId } = req.params;
    const { progress, userId } = req.body;

    if (!progress || !userId) {
      return res.status(400).json({ error: 'Progress and user ID are required' });
    }

    // Verify user owns the subtask or is team leader
    const subtaskResult = await pool.query(
      `SELECT s.*, t.team_code, t.created_by 
       FROM subtasks s 
       JOIN tasks t ON s.task_id = t.id 
       WHERE s.id = $1`,
      [subtaskId]
    );

    if (subtaskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subtask not found' });
    }

    const subtask = subtaskResult.rows[0];

    // Check authorization
    const userCheck = await pool.query(
      'SELECT role, team_code FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(403).json({ error: 'User not found' });
    }

    const user = userCheck.rows[0];
    const isOwner = subtask.assigned_to === parseInt(userId);
    const isLeader = user.role === 'leader' && user.team_code === subtask.team_code;
    const isTaskCreator = subtask.created_by === parseInt(userId);

    if (!isOwner && !isLeader && !isTaskCreator) {
      return res.status(403).json({ error: 'Not authorized to update this subtask' });
    }

    // Update progress
    const result = await pool.query(
      'UPDATE subtasks SET progress = $1 WHERE id = $2 RETURNING *',
      [progress, subtaskId]
    );

    // Update status based on progress
    let status = subtask.status;
    if (progress === 'completed') {
      status = 'completed';
    } else if (progress === 'in_progress' && status === 'assigned') {
      status = 'taken';
    }

    await pool.query(
      'UPDATE subtasks SET status = $1 WHERE id = $2',
      [status, subtaskId]
    );

    const updatedSubtask = await getSubtaskWithDetails(subtaskId);

    res.json({ 
      message: 'Progress updated successfully', 
      subtask: updatedSubtask
    });
  } catch (error) {
    console.error('Update progress error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's assigned subtasks
router.get('/user/:userId/subtasks', async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT s.*, t.title as task_title, t.description as task_description,
              t.team_code, u.name as assigned_to_name, uc.name as created_by_name
       FROM subtasks s
       JOIN tasks t ON s.task_id = t.id
       LEFT JOIN users u ON s.assigned_to = u.id
       LEFT JOIN users uc ON t.created_by = uc.id
       WHERE s.assigned_to = $1
       ORDER BY 
         CASE s.progress 
           WHEN 'not_started' THEN 1
           WHEN 'assigned' THEN 2
           WHEN 'in_progress' THEN 3
           WHEN 'testing' THEN 4
           WHEN 'completed' THEN 5
           ELSE 6
         END,
         s.created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get user subtasks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update task deadline
router.put('/subtask/:subtaskId/deadline', async (req, res) => {
  try {
    const { subtaskId } = req.params;
    const { deadline, userId } = req.body;

    if (!deadline || !userId) {
      return res.status(400).json({ error: 'Deadline and user ID are required' });
    }

    // Verify user is team leader
    const userCheck = await pool.query(
      'SELECT role, team_code FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0 || userCheck.rows[0].role !== 'leader') {
      return res.status(403).json({ error: 'Only team leaders can update deadlines' });
    }

    const result = await pool.query(
      'UPDATE subtasks SET deadline = $1 WHERE id = $2 RETURNING *',
      [deadline, subtaskId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subtask not found' });
    }

    const updatedSubtask = await getSubtaskWithDetails(subtaskId);

    res.json({ 
      message: 'Deadline updated successfully', 
      subtask: updatedSubtask 
    });
  } catch (error) {
    console.error('Update deadline error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete task
router.delete('/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Verify user is task creator or team leader
    const taskResult = await pool.query(
      'SELECT created_by, team_code FROM tasks WHERE id = $1',
      [taskId]
    );

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];

    const userCheck = await pool.query(
      'SELECT role, team_code FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(403).json({ error: 'User not found' });
    }

    const user = userCheck.rows[0];

    const isCreator = task.created_by === parseInt(userId);
    const isLeader = user.role === 'leader' && user.team_code === task.team_code;

    if (!isCreator && !isLeader) {
      return res.status(403).json({ error: 'Not authorized to delete this task' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete subtasks first
      await client.query('DELETE FROM subtasks WHERE task_id = $1', [taskId]);
      
      // Delete task
      await client.query('DELETE FROM tasks WHERE id = $1', [taskId]);

      await client.query('COMMIT');

      res.json({ message: 'Task deleted successfully' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Delete task error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete subtask
router.delete('/subtask/:subtaskId', async (req, res) => {
  try {
    const { subtaskId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Verify user is task creator or team leader
    const subtaskResult = await pool.query(
      `SELECT t.created_by, t.team_code 
       FROM subtasks s 
       JOIN tasks t ON s.task_id = t.id 
       WHERE s.id = $1`,
      [subtaskId]
    );

    if (subtaskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subtask not found' });
    }

    const subtask = subtaskResult.rows[0];

    const userCheck = await pool.query(
      'SELECT role, team_code FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(403).json({ error: 'User not found' });
    }

    const user = userCheck.rows[0];

    const isCreator = subtask.created_by === parseInt(userId);
    const isLeader = user.role === 'leader' && user.team_code === subtask.team_code;

    if (!isCreator && !isLeader) {
      return res.status(403).json({ error: 'Not authorized to delete this subtask' });
    }

    const result = await pool.query(
      'DELETE FROM subtasks WHERE id = $1 RETURNING *',
      [subtaskId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subtask not found' });
    }

    res.json({ message: 'Subtask deleted successfully' });
  } catch (error) {
    console.error('Delete subtask error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to get subtasks for a task
async function getSubtasksForTask(taskId) {
  const subtasksResult = await pool.query(
    `SELECT s.*, u.name as assigned_to_name, u.email as assigned_to_email
     FROM subtasks s 
     LEFT JOIN users u ON s.assigned_to = u.id 
     WHERE s.task_id = $1 
     ORDER BY s.created_at`,
    [taskId]
  );
  return subtasksResult.rows;
}

// Helper function to get task with subtasks
async function getTaskWithSubtasks(taskId) {
  const taskResult = await pool.query(
    `SELECT t.*, u.name as created_by_name
     FROM tasks t
     LEFT JOIN users u ON t.created_by = u.id
     WHERE t.id = $1`,
    [taskId]
  );

  if (taskResult.rows.length === 0) {
    return null;
  }

  const task = taskResult.rows[0];
  task.subtasks = await getSubtasksForTask(taskId);
  
  return task;
}

// Helper function to get subtask with details
async function getSubtaskWithDetails(subtaskId) {
  const result = await pool.query(
    `SELECT s.*, u.name as assigned_to_name, u.email as assigned_to_email,
            t.title as task_title, t.description as task_description
     FROM subtasks s
     LEFT JOIN users u ON s.assigned_to = u.id
     JOIN tasks t ON s.task_id = t.id
     WHERE s.id = $1`,
    [subtaskId]
  );
  
  return result.rows[0];
}

// Add these routes to your existing tasks.js file

// Edit task
router.put('/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { title, description, userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Verify user is task creator or team leader
    const taskResult = await pool.query(
      'SELECT created_by, team_code FROM tasks WHERE id = $1',
      [taskId]
    );

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];

    const userCheck = await pool.query(
      'SELECT role, team_code FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(403).json({ error: 'User not found' });
    }

    const user = userCheck.rows[0];
    const isCreator = task.created_by === parseInt(userId);
    const isLeader = user.role === 'leader' && user.team_code === task.team_code;

    if (!isCreator && !isLeader) {
      return res.status(403).json({ error: 'Not authorized to edit this task' });
    }

    // Update task
    const result = await pool.query(
      'UPDATE tasks SET title = $1, description = $2 WHERE id = $3 RETURNING *',
      [title, description, taskId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Get updated task with subtasks
    const updatedTask = await getTaskWithSubtasks(taskId);

    res.json({ 
      message: 'Task updated successfully', 
      task: updatedTask 
    });
  } catch (error) {
    console.error('Edit task error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Edit subtask
router.put('/subtask/:subtaskId', async (req, res) => {
  try {
    const { subtaskId } = req.params;
    const { title, description, assigned_to, userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Verify user is task creator or team leader
    const subtaskResult = await pool.query(
      `SELECT t.created_by, t.team_code 
       FROM subtasks s 
       JOIN tasks t ON s.task_id = t.id 
       WHERE s.id = $1`,
      [subtaskId]
    );

    if (subtaskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subtask not found' });
    }

    const subtask = subtaskResult.rows[0];

    const userCheck = await pool.query(
      'SELECT role, team_code FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(403).json({ error: 'User not found' });
    }

    const user = userCheck.rows[0];
    const isCreator = subtask.created_by === parseInt(userId);
    const isLeader = user.role === 'leader' && user.team_code === subtask.team_code;

    if (!isCreator && !isLeader) {
      return res.status(403).json({ error: 'Not authorized to edit this subtask' });
    }

    // Determine status based on assignment
    let status = 'available';
    let progress = 'not_started';
    
    if (assigned_to) {
      status = 'assigned';
      progress = 'assigned';
    }

    // Update subtask
    const result = await pool.query(
      `UPDATE subtasks 
       SET title = $1, description = $2, assigned_to = $3, status = $4, progress = $5
       WHERE id = $6 
       RETURNING *`,
      [title, description, assigned_to, status, progress, subtaskId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subtask not found' });
    }

    const updatedSubtask = await getSubtaskWithDetails(subtaskId);

    res.json({ 
      message: 'Subtask updated successfully', 
      subtask: updatedSubtask 
    });
  } catch (error) {
    console.error('Edit subtask error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get tasks by status (active/completed)
router.get('/team/:teamCode/status/:status', async (req, res) => {
  try {
    const { teamCode, status } = req.params;

    let statusCondition = '';
    if (status === 'active') {
      statusCondition = "AND s.status != 'completed'";
    } else if (status === 'completed') {
      statusCondition = "AND s.status = 'completed'";
    }

    const tasksResult = await pool.query(
      `SELECT DISTINCT t.*, u.name as created_by_name,
             (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id) as total_subtasks,
             (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.status = 'completed') as completed_subtasks
       FROM tasks t
       LEFT JOIN users u ON t.created_by = u.id
       LEFT JOIN subtasks s ON t.id = s.task_id
       WHERE t.team_code = $1 ${statusCondition}
       ORDER BY t.created_at DESC`,
      [teamCode]
    );

    // Get subtasks for each task
    const tasksWithSubtasks = await Promise.all(
      tasksResult.rows.map(async (task) => {
        const subtasks = await getSubtasksForTask(task.id);
        return {
          ...task,
          subtasks: subtasks
        };
      })
    );

    res.json(tasksWithSubtasks);
  } catch (error) {
    console.error('Get tasks by status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Add these routes to your tasks.js file

// Edit task
router.put('/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { title, description, userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Verify user is task creator or team leader
    const taskResult = await pool.query(
      'SELECT created_by, team_code FROM tasks WHERE id = $1',
      [taskId]
    );

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];

    const userCheck = await pool.query(
      'SELECT role, team_code FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(403).json({ error: 'User not found' });
    }

    const user = userCheck.rows[0];
    const isCreator = task.created_by === parseInt(userId);
    const isLeader = user.role === 'leader' && user.team_code === task.team_code;

    if (!isCreator && !isLeader) {
      return res.status(403).json({ error: 'Not authorized to edit this task' });
    }

    // Update task
    const result = await pool.query(
      'UPDATE tasks SET title = $1, description = $2 WHERE id = $3 RETURNING *',
      [title, description, taskId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Get updated task with subtasks
    const updatedTask = await getTaskWithSubtasks(taskId);

    res.json({ 
      message: 'Task updated successfully', 
      task: updatedTask 
    });
  } catch (error) {
    console.error('Edit task error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Edit subtask
router.put('/subtask/:subtaskId', async (req, res) => {
  try {
    const { subtaskId } = req.params;
    const { title, description, assigned_to, userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Verify user is task creator or team leader
    const subtaskResult = await pool.query(
      `SELECT t.created_by, t.team_code 
       FROM subtasks s 
       JOIN tasks t ON s.task_id = t.id 
       WHERE s.id = $1`,
      [subtaskId]
    );

    if (subtaskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subtask not found' });
    }

    const subtask = subtaskResult.rows[0];

    const userCheck = await pool.query(
      'SELECT role, team_code FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(403).json({ error: 'User not found' });
    }

    const user = userCheck.rows[0];
    const isCreator = subtask.created_by === parseInt(userId);
    const isLeader = user.role === 'leader' && user.team_code === subtask.team_code;

    if (!isCreator && !isLeader) {
      return res.status(403).json({ error: 'Not authorized to edit this subtask' });
    }

    // Determine status based on assignment
    let status = 'available';
    let progress = 'not_started';
    
    if (assigned_to) {
      status = 'assigned';
      progress = 'assigned';
    }

    // Update subtask
    const result = await pool.query(
      `UPDATE subtasks 
       SET title = $1, description = $2, assigned_to = $3, status = $4, progress = $5
       WHERE id = $6 
       RETURNING *`,
      [title, description, assigned_to, status, progress, subtaskId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subtask not found' });
    }

    const updatedSubtask = await getSubtaskWithDetails(subtaskId);

    res.json({ 
      message: 'Subtask updated successfully', 
      subtask: updatedSubtask 
    });
  } catch (error) {
    console.error('Edit subtask error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get tasks by status
router.get('/team/:teamCode/status/:status', async (req, res) => {
  try {
    const { teamCode, status } = req.params;

    let statusCondition = '';
    if (status === 'active') {
      statusCondition = "AND (s.status != 'completed' OR s.status IS NULL)";
    } else if (status === 'completed') {
      statusCondition = "AND s.status = 'completed'";
    }

    const tasksResult = await pool.query(
      `SELECT DISTINCT t.*, u.name as created_by_name,
             (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id) as total_subtasks,
             (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.status = 'completed') as completed_subtasks
       FROM tasks t
       LEFT JOIN users u ON t.created_by = u.id
       LEFT JOIN subtasks s ON t.id = s.task_id
       WHERE t.team_code = $1 ${statusCondition}
       ORDER BY t.created_at DESC`,
      [teamCode]
    );

    // Get subtasks for each task
    const tasksWithSubtasks = await Promise.all(
      tasksResult.rows.map(async (task) => {
        const subtasks = await getSubtasksForTask(task.id);
        return {
          ...task,
          subtasks: subtasks
        };
      })
    );

    res.json(tasksWithSubtasks);
  } catch (error) {
    console.error('Get tasks by status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
module.exports = router;