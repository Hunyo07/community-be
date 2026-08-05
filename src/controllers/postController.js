import { pool } from '../config/db.js';

// This controller provides basic CRUD operations for sample community posts.
// It reads and writes the posts table and returns JSON for the frontend.

// Lists all posts newest first.
export const getPosts = async (req, res, next) => {
  try {
    const [posts] = await pool.query(
      `SELECT id, title, content, author, created_at AS createdAt, updated_at AS updatedAt
       FROM posts
       ORDER BY created_at DESC`
    );

    res.json({ data: posts });
  } catch (error) {
    next(error);
  }
};

// Returns one post by id, or 404 if it does not exist.
export const getPostById = async (req, res, next) => {
  try {
    const [posts] = await pool.execute(
      `SELECT id, title, content, author, created_at AS createdAt, updated_at AS updatedAt
       FROM posts
       WHERE id = ?`,
      [req.params.id]
    );

    if (posts.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    return res.json({ data: posts[0] });
  } catch (error) {
    return next(error);
  }
};

// Creates a new post after checking that title and content were provided.
export const createPost = async (req, res, next) => {
  try {
    const { title, content, author = 'Anonymous' } = req.body;

    if (!title || !content) {
      return res.status(400).json({ message: 'Title and content are required' });
    }

    const [result] = await pool.execute(
      'INSERT INTO posts (title, content, author) VALUES (?, ?, ?)',
      [title, content, author]
    );

    const [posts] = await pool.execute(
      `SELECT id, title, content, author, created_at AS createdAt, updated_at AS updatedAt
       FROM posts
       WHERE id = ?`,
      [result.insertId]
    );

    return res.status(201).json({ data: posts[0] });
  } catch (error) {
    return next(error);
  }
};

// Updates only the fields that were sent in the request body.
export const updatePost = async (req, res, next) => {
  try {
    const { title, content, author } = req.body;

    if (!title && !content && !author) {
      return res.status(400).json({ message: 'Provide at least one field to update' });
    }

    const fields = [];
    const values = [];

    if (title) {
      fields.push('title = ?');
      values.push(title);
    }

    if (content) {
      fields.push('content = ?');
      values.push(content);
    }

    if (author) {
      fields.push('author = ?');
      values.push(author);
    }

    values.push(req.params.id);

    const [result] = await pool.execute(
      `UPDATE posts SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const [posts] = await pool.execute(
      `SELECT id, title, content, author, created_at AS createdAt, updated_at AS updatedAt
       FROM posts
       WHERE id = ?`,
      [req.params.id]
    );

    return res.json({ data: posts[0] });
  } catch (error) {
    return next(error);
  }
};

// Deletes a post by id and returns 204 when successful.
export const deletePost = async (req, res, next) => {
  try {
    const [result] = await pool.execute('DELETE FROM posts WHERE id = ?', [req.params.id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
};
