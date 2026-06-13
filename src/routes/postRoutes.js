import { Router } from 'express';
import {
  createPost,
  deletePost,
  getPostById,
  getPosts,
  updatePost
} from '../controllers/postController.js';

const router = Router();

router.get('/', getPosts);
router.get('/:id', getPostById);
router.post('/', createPost);
router.patch('/:id', updatePost);
router.delete('/:id', deletePost);

export default router;
