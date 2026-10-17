const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
    const token = req.cookies.session;

    if (!token) {
        return res.status(401).json({
            error: "Authentication required."
        });
    }

    try {
        req.user = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        next();
    } catch (error) {
        return res.status(401).json({
            error: "Session expired. Please log in again."
        });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({
                error: "You are not authorized for this action."
            });
        }

        next();
    };
}

module.exports = {
    requireAuth,
    requireRole
};