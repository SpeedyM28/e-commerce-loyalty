import { Router } from 'express';
import { User } from '../models/User';

const router = Router();

// Minimal creation endpoint — no auth/signup flow, just enough to have a
// userId to place test orders against.
router.post('/', async (req, res) => {
  try {
    const { email, name } = req.body as { email?: string; name?: string };
    if (!email || !name) {
      res.status(400).json({ error: 'email and name are required' });
      return;
    }
    const user = await User.create({ email, name });
    res.status(201).json(user);
  } catch (err) {
    if ((err as { name?: string }).name === 'ValidationError' || (err as { code?: number }).code === 11000) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// Listing endpoint for the frontend's user picker (no auth to derive "current
// user" from).
router.get('/', async (_req, res) => {
  try {
    const users = await User.find().select('email name loyalty').sort({ createdAt: 1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
